import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyOAuthBridge, BRIDGE_PAGE, BRIDGE_PAGE_CS, BRIDGE_BACKGROUND } from "../dist/runtime/oauth-bridge.js";
import { fakeBrowser, makeEvent } from "./shim-sandbox.js";

// Chrome keeps a bridged page's sendMessage open for as long as the add-on's
// listener holds its answer: a sign-in the user finishes in another window
// takes minutes. The relay gave up after 30 s and the page after 31 s, so the
// page got "No response from the extension." while the listener was still
// working. Timers here run a thousand times fast: 1 s of the bridge's is 1 ms.

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = "https://app.example.com";
const fastTimeout = (fn, ms, ...a) => setTimeout(fn, ms >= 1000 ? ms / 1000 : ms, ...a);
const fastInterval = (fn, ms, ...a) => setInterval(fn, ms >= 1000 ? ms / 1000 : ms, ...a);

function world(source, globals) {
  const sandbox = { console, setTimeout: fastTimeout, clearTimeout, setInterval: fastInterval, clearInterval, Promise, JSON, URL, CustomEvent, ...globals };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

function portPair(name, sender) {
  const a = { name, onMessage: makeEvent(), onDisconnect: makeEvent() };
  const b = { name, sender, onMessage: makeEvent(), onDisconnect: makeEvent() };
  const link = (from, to) => {
    from.postMessage = (m) => { const copy = structuredClone(m); setTimeout(() => to.onMessage.fire(copy, to), 0); };
    from.disconnect = () => { setTimeout(() => to.onDisconnect.fire(to), 0); };
  };
  link(a, b);
  link(b, a);
  return [a, b];
}

function bridge(t, { relay = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-long-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "sw.js"), "");
  applyOAuthBridge(dir, { manifest_version: 3, name: "T", version: "1", background: { service_worker: "sw.js" }, externally_connectable: { matches: [ORIGIN + "/*"] } }, CHROME_ID);
  const read = (f) => readFileSync(join(dir, f), "utf-8");
  const win = new EventTarget();
  win.location = { origin: ORIGIN, href: ORIGIN + "/login" };
  const bg = fakeBrowser();
  world(read(BRIDGE_BACKGROUND), { browser: bg, chrome: bg });
  const ports = [];
  if (relay) {
    const cs = fakeBrowser();
    cs.runtime.connect = ({ name }) => {
      const [mine, theirs] = portPair(name, { url: ORIGIN + "/login", tab: { id: 1 }, frameId: 0 });
      ports.push(theirs);
      bg.runtime.onConnect.fire(theirs);
      return mine;
    };
    world(read(BRIDGE_PAGE_CS), { browser: cs, chrome: cs, window: win, location: win.location });
  }
  world(read(BRIDGE_PAGE), { window: win, location: win.location });
  return { win, bg, ports };
}

test("an answer that takes minutes still reaches the page", async (t) => {
  const { win, bg } = bridge(t);
  // Two minutes of the bridge's time.
  bg.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => { fastTimeout(() => sendResponse({ signedIn: true }), 120000); return true; });
  assert.deepEqual(await win.chrome.runtime.sendMessage(CHROME_ID, { type: "login" }), { signedIn: true });
  // Firefox suspends an idle event page after 30 s, open port or not; an API
  // call every 20 s kept it awake meanwhile, and stops with the answer.
  const awake = bg.calls.filter((c) => c[0] === "runtime.getPlatformInfo").length;
  assert.ok(awake >= 4, `kept awake ${awake} times`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(bg.calls.filter((c) => c[0] === "runtime.getPlatformInfo").length, awake);
});

test("a background that goes away still fails the page's call", async (t) => {
  const { win, bg, ports } = bridge(t);
  bg.runtime.onMessageExternal.addListener(() => true);
  const reply = win.chrome.runtime.sendMessage(CHROME_ID, { type: "login" });
  await new Promise((r) => setTimeout(r, 5));
  ports[0].disconnect();
  await assert.rejects(reply, /closed the connection without answering/);
});

test("with no relay to carry it, the page's call fails after its own deadline", async (t) => {
  const { win } = bridge(t, { relay: false });
  await assert.rejects(win.chrome.runtime.sendMessage(CHROME_ID, { type: "login" }), /Receiving end does not exist/);
});
