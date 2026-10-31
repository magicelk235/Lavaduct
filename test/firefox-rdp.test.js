import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { RdpError, RdpSession } from "../dist/firefox/rdp.js";

const ADDONS_ACTOR = "server1.conn0.addonsActor2";

function frame(message) {
  const json = JSON.stringify(message);
  return Buffer.from(`${Buffer.byteLength(json)}:${json}`);
}

/**
 * A stand-in for Firefox's devtools server. `script(packet, send)` answers each
 * packet the client sends; packets are read by byte length, as Firefox does.
 * `greet` writes the greeting, by default whole.
 */
async function fakeServer(t, { script = () => {}, greet = (socket) => socket.write(frame(GREETING)), listen = { port: 0, host: "127.0.0.1" } } = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const colon = buffer.indexOf(":");
        if (colon < 0) return;
        const length = Number(buffer.subarray(0, colon).toString());
        if (buffer.length < colon + 1 + length) return;
        const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString("utf-8"));
        buffer = buffer.subarray(colon + 1 + length);
        received.push(packet);
        script(packet, (...messages) => socket.write(Buffer.concat(messages.map(frame))));
      }
    });
    socket.on("error", () => {});
    greet(socket);
  });
  server.listen(listen);
  await once(server, "listening");
  t.after(() => server.close());
  const address = typeof listen.path === "string" ? { path: listen.path } : { port: server.address().port };
  return { address, received };
}

const GREETING = { from: "root", applicationType: "browser", traits: { name: "Firefox 🦊" } };

/** Answers getRoot, then installTemporaryAddon with `install`. */
function addonsScript(install) {
  return (packet, send) => {
    if (packet.to === "root" && packet.type === "getRoot") {
      // Events can arrive ahead of a reply from the same actor.
      send({ from: "root", type: "tabListChanged" }, { from: "root", addonsActor: ADDONS_ACTOR, preferenceActor: "server1.conn0.preferenceActor3" });
    } else if (packet.to === ADDONS_ACTOR && packet.type === "installTemporaryAddon") {
      send(install(packet));
    }
  };
}

function addonDir(t, name) {
  const root = mkdtempSync(join(tmpdir(), "lavaduct-rdp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
}

test("an add-on is installed over a devtools connection whose packets arrive split mid-character", async (t) => {
  // Lengths count bytes: a folder name outside ASCII and an emoji in the
  // greeting break any client that counts characters.
  const dir = addonDir(t, "Ünïcode add-on");
  const { address, received } = await fakeServer(t, {
    greet(socket) {
      const bytes = frame(GREETING);
      const cut = bytes.indexOf(Buffer.from("🦊")) + 2;
      socket.write(bytes.subarray(0, cut));
      setTimeout(() => socket.write(bytes.subarray(cut)), 20);
    },
    script: addonsScript(() => ({ from: ADDONS_ACTOR, addon: { id: "prøbe@example.com", actor: false } })),
  });

  const session = await RdpSession.connect(address);
  try {
    // A relative path reaches Firefox as an absolute one; Firefox resolves nothing.
    assert.equal(await session.installTemporaryAddon(relative(process.cwd(), dir)), "prøbe@example.com");
  } finally {
    session.end();
  }
  assert.deepEqual(received, [
    { to: "root", type: "getRoot" },
    { to: ADDONS_ACTOR, type: "installTemporaryAddon", addonPath: dir, openDevTools: false },
  ]);
});

test("Firefox's refusal of an add-on comes back as an error with its reason", async (t) => {
  const dir = addonDir(t, "broken");
  const { address } = await fakeServer(t, {
    script: addonsScript((packet) => ({
      from: ADDONS_ACTOR,
      error: "unknownError",
      message: `Could not install add-on at '${packet.addonPath}': Error: Extension is invalid`,
    })),
  });
  const session = await RdpSession.connect(address);
  try {
    await assert.rejects(session.installTemporaryAddon(dir), /Firefox refused the add-on at .*broken.*Extension is invalid/);
    await assert.rejects(session.installTemporaryAddon(join(dir, "missing")), /Nothing to install at/);
  } finally {
    session.end();
  }
});

test("something other than a devtools server on the address is refused, not waited on forever", async (t) => {
  const http = await fakeServer(t, { greet: (socket) => socket.write("HTTP/1.1 400 Bad Request\r\n\r\n") });
  await assert.rejects(RdpSession.connect(http.address), /isn't Firefox's devtools server/);

  const silent = await fakeServer(t, { greet: () => {} });
  await assert.rejects(RdpSession.connect(silent.address, 300), /didn't greet/);

  // Nothing listens there any more.
  const closed = net.createServer().listen(0, "127.0.0.1");
  await once(closed, "listening");
  const gone = closed.address().port;
  closed.close();
  await once(closed, "close");
  await assert.rejects(RdpSession.connect({ port: gone }), /Can't connect to Firefox's devtools server/);
});

test("a watched event is handed over whether it arrives before or after the reply that names it", async (t) => {
  for (const eventFirst of [false, true]) {
    const { address } = await fakeServer(t, {
      script(packet, send) {
        if (packet.type !== "evaluateJSAsync") return;
        const reply = { from: packet.to, resultID: "r1" };
        const event = { from: packet.to, type: "evaluationResult", resultID: "r1", result: "done" };
        send(...(eventFirst ? [event, reply] : [reply, event]));
      },
    });
    const session = await RdpSession.connect(address);
    try {
      session.watchEvents("evaluationResult");
      const { resultID } = await session.request("console1", "evaluateJSAsync", { text: "1" });
      const event = await session.takeEvent("evaluationResult", (e) => e.resultID === resultID);
      assert.equal(event.result, "done");
      await assert.rejects(session.takeEvent("tabListChanged", () => true), /aren't watched/);
    } finally {
      session.end();
    }
  }
});

test("an error reply rejects the request with Firefox's message, and the end of the connection is announced", async (t) => {
  const { address } = await fakeServer(t, {
    script(packet, send) {
      send({ from: packet.to, error: "noSuchActor", message: "No such actor for ID: nope" });
    },
  });
  const session = await RdpSession.connect(address);
  await assert.rejects(session.request("nope", "anything"), (err) => err instanceof RdpError && /No such actor/.test(err.message));
  session.end();
  await session.disconnected;
});

test(
  "a devtools server on a Unix socket is reached by its path",
  { skip: process.platform === "win32" ? "Firefox's devtools server has no Unix sockets on Windows" : false },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "lavaduct-rdp-sock-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { address } = await fakeServer(t, {
      listen: { path: join(dir, "socket") },
      script: addonsScript(() => ({ from: ADDONS_ACTOR, addon: { id: "sock@example.com", actor: false } })),
    });
    const session = await RdpSession.connect(address);
    try {
      assert.equal(await session.installTemporaryAddon(addonDir(t, "ext")), "sock@example.com");
    } finally {
      session.end();
    }
  },
);
