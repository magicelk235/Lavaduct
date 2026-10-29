// A headless Firefox on a throwaway profile, driven through its devtools server
// with chrome privileges, for tests that work Firefox's own UI (the sidebar,
// the selected tab), which add-on APIs and WebDriver BiDi can't reach. Not a
// test file itself.
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchFirefox } from "../dist/firefox/launch.js";
import { enableDebuggerServerInProfile } from "../dist/firefox/install.js";

const START_TIMEOUT_MS = 30_000;
const REPLY_TIMEOUT_MS = 60_000;

class Client {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiting = new Map();
    // Evaluation results are events, and one can come in the same read as the
    // reply naming it, so they are kept until taken.
    this.results = new Map();
    this.resultWaiters = new Map();
    socket.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const colon = this.buffer.indexOf(0x3a);
      if (colon < 0) return;
      const end = colon + 1 + Number(this.buffer.toString("latin1", 0, colon));
      if (this.buffer.length < end) return;
      const packet = JSON.parse(this.buffer.toString("utf-8", colon + 1, end));
      this.buffer = this.buffer.subarray(end);
      this.onPacket(packet);
    }
  }

  onPacket(packet) {
    if (packet.type === "evaluationResult") {
      const waiter = this.resultWaiters.get(packet.resultID);
      if (waiter) {
        this.resultWaiters.delete(packet.resultID);
        waiter(packet);
      } else {
        this.results.set(packet.resultID, packet);
      }
      return;
    }
    // Other events carry a type too; replies don't, and come in order.
    if (packet.type) return;
    const queue = this.waiting.get(packet.from);
    const next = queue?.shift();
    if (next) next(packet);
  }

  /** The next reply from `actor`, for a request already sent (or the greeting). */
  reply(actor) {
    return new Promise((resolve, reject) => {
      // Unref'd: a request Firefox quits before answering mustn't keep the test running.
      const timer = setTimeout(() => reject(new Error(`no reply from ${actor}`)), REPLY_TIMEOUT_MS).unref();
      if (!this.waiting.has(actor)) this.waiting.set(actor, []);
      this.waiting.get(actor).push((packet) => {
        clearTimeout(timer);
        if (packet.error) reject(new Error(`${packet.error}: ${packet.message}`));
        else resolve(packet);
      });
    });
  }

  request(to, type, params = {}) {
    const reply = this.reply(to);
    const json = JSON.stringify({ to, type, ...params });
    this.socket.write(`${Buffer.byteLength(json)}:${json}`);
    return reply;
  }

  result(id) {
    const done = this.results.get(id);
    if (done) {
      this.results.delete(id);
      return Promise.resolve(done);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no evaluation result")), REPLY_TIMEOUT_MS).unref();
      this.resultWaiters.set(id, (packet) => {
        clearTimeout(timer);
        resolve(packet);
      });
    });
  }
}

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

/**
 * Start Firefox headless on `profile` with its devtools server, and return
 * `chrome(js)`, which runs `js` in Firefox's parent process and resolves with
 * its (awaited) value, plus `installAddon(dir)` and `close()`.
 */
export async function startPrivilegedFirefox(install, profile) {
  enableDebuggerServerInProfile(profile);
  let socketDir;
  let address;
  if (process.platform === "win32") {
    address = { port: await freePort() };
  } else {
    socketDir = mkdtempSync(join(tmpdir(), "lavaduct-ui-"));
    address = { path: join(socketDir, "socket") };
  }
  const child = launchFirefox(install, ["--start-debugger-server", address.path ?? String(address.port), "--profile", profile], { headless: true });

  let client;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!client) {
    const socket = address.path ? createConnection(address.path) : createConnection(address.port, "127.0.0.1");
    try {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      client = new Client(socket);
    } catch {
      socket.destroy();
      if (Date.now() > deadline) {
        child.kill();
        throw new Error("Firefox's devtools server never came up");
      }
      await sleep(100);
    }
  }
  await client.reply("root");
  const root = await client.request("root", "getRoot");
  const process0 = await client.request("root", "getProcess", { id: 0 });
  const target = await client.request(process0.processDescriptor.actor, "getTarget");
  const consoleActor = (target.process ?? target.form).consoleActor;

  async function chrome(text) {
    const { resultID } = await client.request(consoleActor, "evaluateJSAsync", { text, mapped: { await: true } });
    const result = await client.result(resultID);
    if (result.exception != null) throw new Error(`chrome eval failed: ${result.exceptionMessage ?? JSON.stringify(result.exception)}`);
    const grip = result.result;
    if (grip && typeof grip === "object" && grip.type === "longString") {
      return (await client.request(grip.actor, "substring", { start: 0, end: grip.length })).substring;
    }
    return grip && typeof grip === "object" && grip.type === "undefined" ? undefined : grip;
  }

  // The first window comes up with an onboarding dialog in a new profile,
  // which keeps the user from switching tabs until it is closed.
  for (let i = 0; i < 300; i++) {
    const state = await chrome(`(async () => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (!win || !win.gBrowser) return "starting";
      await win.delayedStartupPromise;
      if (win.gDialogBox?.isOpen) { win.gDialogBox.dialog?.close(); return "dialog"; }
      return "ready";
    })()`).catch(() => "starting");
    if (state === "ready") break;
    await sleep(100);
  }

  return {
    chrome,
    async installAddon(dir) {
      const reply = await client.request(root.addonsActor, "installTemporaryAddon", { addonPath: dir, openDevTools: false });
      return reply.addon.id;
    },
    async close() {
      // Firefox quits before it can answer.
      const exited = once(child, "exit");
      chrome("Services.startup.quit(Ci.nsIAppStartup.eForceQuit)").catch(() => {});
      await Promise.race([exited, sleep(10_000, undefined, { ref: false })]);
      child.kill();
      client.socket.destroy();
      if (socketDir) rmSync(socketDir, { recursive: true, force: true });
    },
  };
}
