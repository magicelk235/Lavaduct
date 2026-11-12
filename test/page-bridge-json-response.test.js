import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyOAuthBridge, BRIDGE_PAGE, BRIDGE_PAGE_CS, BRIDGE_BACKGROUND } from "../dist/runtime/oauth-bridge.js";
import { fakeBrowser, makeEvent } from "./shim-sandbox.js";

// Chrome sends an extension's answer to a web page as JSON, so a function in
// it drops out. Firefox's port.postMessage structured-clones instead and
// throws "DataCloneError: Function object could not be cloned." The receiver
// swallowed that, and the page waited 30 seconds for an error.

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = "https://app.example.com";

function bridge(t) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-json-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "sw.js"), "");
  applyOAuthBridge(dir, {
    manifest_version: 3, name: "T", version: "1",
    background: { service_worker: "sw.js" },
    externally_connectable: { matches: [`${ORIGIN}/*`] },
  }, CHROME_ID);

  // The bridge's own timeouts, cleared when the test ends.
  const timers = new Set();
  const setT = (fn, ms) => { const h = setTimeout(() => { timers.delete(h); fn(); }, ms); timers.add(h); return h; };
  const clearT = (h) => { timers.delete(h); clearTimeout(h); };
  t.after(() => { for (const h of timers) clearTimeout(h); });
  const world = (file, globals) => {
    const sandbox = { console, setTimeout: setT, clearTimeout: clearT, setInterval, clearInterval, Promise, JSON, URL, CustomEvent, ...globals };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(dir, file), "utf-8"), sandbox);
  };

  const win = new EventTarget();
  win.location = { origin: ORIGIN, href: `${ORIGIN}/login` };
  const bg = fakeBrowser();
  world(BRIDGE_BACKGROUND, { browser: bg, chrome: bg });

  // A port: what one side posts is structured-cloned, as Firefox does, and
  // posting what can't be cloned throws.
  const cs = fakeBrowser();
  cs.runtime.connect = ({ name }) => {
    const mine = { name, onMessage: makeEvent(), onDisconnect: makeEvent() };
    const theirs = { name, sender: { url: win.location.href, tab: { id: 1 }, frameId: 0 }, onMessage: makeEvent(), onDisconnect: makeEvent() };
    const link = (from, to) => {
      from.postMessage = (m) => { const copy = structuredClone(m); setTimeout(() => to.onMessage.fire(copy, to), 0); };
      from.disconnect = () => { setTimeout(() => to.onDisconnect.fire(to), 0); };
    };
    link(mine, theirs);
    link(theirs, mine);
    bg.runtime.onConnect.fire(theirs);
    return mine;
  };
  world(BRIDGE_PAGE_CS, { browser: cs, chrome: cs, window: win, location: win.location });
  world(BRIDGE_PAGE, { window: win, location: win.location });
  return { win, bg };
}

const within = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))]);

test("an answer holding a function reaches the page as JSON, without the function", async (t) => {
  const { win, bg } = bridge(t);
  bg.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    sendResponse({ ok: true, at: new Date(0), done() {}, nothing: undefined });
  });
  const reply = await within(win.chrome.runtime.sendMessage(CHROME_ID, { type: "ping" }), 2000);
  assert.deepEqual(reply, { ok: true, at: "1970-01-01T00:00:00.000Z" });
});

test("an answer JSON can't hold fails at once instead of timing out", async (t) => {
  const { win, bg } = bridge(t);
  bg.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    const cyclic = { ok: true };
    cyclic.self = cyclic;
    sendResponse(cyclic);
  });
  await assert.rejects(within(win.chrome.runtime.sendMessage(CHROME_ID, {}), 2000), /could not be serialized/);
});
