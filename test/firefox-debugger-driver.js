// Runs a small Chrome extension that drives a tab through chrome.debugger in a
// real Firefox, headless and on a throwaway profile. Not a test file itself.
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-debugger-driver-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { BidiSession } = await import("../dist/firefox/bidi.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { readDebugLog } = await import("../dist/firefox/storage.js");

export const firefox = selectFirefox(findFirefoxInstalls());

// Helpers the background gets ahead of its `run()`: `log(step, data)` records
// what it saw in storage.local, where readDebugLog finds it; `openTab(url)`
// resolves once the tab has loaded; `debuggee(tab)` attaches and returns
// `send(method, params)` and `evaluate(expression)`, callback-style calls
// checked against runtime.lastError.
const PRELUDE = String.raw`
const out = [];
function log(step, data) {
  out.push({ t: Date.now(), ctx: "test", msg: JSON.stringify(Object.assign({ step }, data)) });
  return chrome.storage.local.set({ __viaduct_debug_log__: out });
}
function call(fn) {
  return new Promise((resolve, reject) => fn((result) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(result))));
}
async function openTab(url) {
  const tab = await chrome.tabs.create({ url });
  await new Promise((resolve) => {
    const loaded = (id, change) => {
      if (id !== tab.id || change.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(loaded);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(loaded);
  });
  return tab;
}
async function debuggee(tab) {
  const target = { tabId: tab.id };
  await call((cb) => chrome.debugger.attach(target, "1.3", cb));
  const send = (method, params) => call((cb) => chrome.debugger.sendCommand(target, method, params || {}, cb));
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  return { send, evaluate };
}
`;

/**
 * Convert an extension whose background is PRELUDE, `const ORIGIN`, and
 * `background` (which defines `async function run()`), serve `pages` (path →
 * HTML) at ORIGIN, run it in Firefox and return the logged steps by name.
 */
export async function driveInFirefox({ background, pages }) {
  const dir = mkdtempSync(join(scratch, "run-"));
  const server = http.createServer((req, res) => {
    const html = pages[req.url.split("?")[0]];
    res.writeHead(html === undefined ? 404 : 200, { "content-type": "text/html" });
    res.end(html ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const ext = join(dir, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Tab Driver", version: "1.0",
      permissions: ["debugger", "storage"],
      background: { service_worker: "sw.js" },
    }));
    writeFileSync(join(ext, "sw.js"), [
      `const ORIGIN = "http://127.0.0.1:${server.address().port}";`,
      PRELUDE,
      background,
      `run().then(() => log("done", {}), (e) => log("failed", { error: String((e && e.stack) || e) }));`,
    ].join("\n"));
    const result = await convert({
      input: ext, output: join(dir, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    if (!result.success) throw new Error("the extension didn't convert");
    const profile = join(dir, "profile");
    mkdirSync(profile);
    const session = await BidiSession.start(firefox, profile);
    let steps = {};
    try {
      const id = await session.installExtension(result.stagedPath);
      for (let i = 0; i < 120 && !steps.done && !steps.failed; i++) {
        await sleep(500);
        try {
          steps = Object.fromEntries(readDebugLog(profile, id).entries.map((e) => {
            const m = JSON.parse(e.msg);
            return [m.step, m];
          }));
        } catch {
          // Firefox hasn't written the storage yet.
        }
      }
    } finally {
      await session.closeBrowser();
    }
    return steps;
  } finally {
    server.close();
  }
}

/** Remove the scratch directory; call from the test's `after`. */
export function cleanUp() {
  rmSync(scratch, { recursive: true, force: true });
}
