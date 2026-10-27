import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { applyOAuthBridge, BRIDGE_PAGE, BRIDGE_PAGE_CS, BRIDGE_BACKGROUND } from "../dist/runtime/oauth-bridge.js";
import { wireBackground, SHIM_FILENAME } from "../dist/runtime/shim.js";
import { fakeBrowser, makeEvent, tick } from "./shim-sandbox.js";

// Chrome lets the pages listed in externally_connectable.matches call
// chrome.runtime.sendMessage(<extension id>, …). Firefox ignores the key and
// gives web pages no chrome.runtime at all, so a page-world script provides it
// and relays through a content script to the background, where the message is
// handed to the extension's onMessageExternal listeners.

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const MATCHES = ["https://app.example.com/*"];

function stage(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "oauth-bridge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const read = (dir, f) => readFileSync(join(dir, f), "utf-8");

function swManifest(extra = {}) {
  return {
    manifest_version: 3, name: "T", version: "1",
    background: { service_worker: "sw.js" },
    externally_connectable: { matches: MATCHES },
    content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
    ...extra,
  };
}

test("bridging a service-worker extension: page and relay scripts on the matched pages, receiver ahead of the worker", (t) => {
  const dir = stage(t, { "sw.js": '"use strict";\nimportScripts("lib.js");\nchrome.runtime.onMessageExternal.addListener(() => {});\n', "lib.js": "", "cs.js": "" });
  const manifest = swManifest();
  const notes = applyOAuthBridge(dir, manifest, CHROME_ID);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /app\.example\.com/);
  wireBackground(dir, manifest, SHIM_FILENAME);

  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, BRIDGE_BACKGROUND, "lib.js", "sw.js"] });
  const sw = read(dir, "sw.js");
  assert.match(sw, /^"use strict";/, "the directive must stay first or the worker loses strict mode");
  assert.ok(!/\bimportScripts\s*\(/.test(sw));
  assert.deepEqual(manifest.content_scripts.slice(0, 2), [
    { js: [BRIDGE_PAGE], matches: MATCHES, run_at: "document_start", all_frames: false, world: "MAIN" },
    { js: [BRIDGE_PAGE_CS], matches: MATCHES, run_at: "document_start", all_frames: false },
  ]);
  assert.equal(manifest.content_scripts[2].js[0], "cs.js");
  assert.equal(manifest.externally_connectable, undefined, "Firefox only warns about the key");
  for (const f of [BRIDGE_PAGE, BRIDGE_PAGE_CS, BRIDGE_BACKGROUND]) assert.ok(existsSync(join(dir, f)), f);
  assert.ok(read(dir, BRIDGE_PAGE).includes(CHROME_ID));
});

test("bridging after the worker was already wired puts the receiver right after the shim", (t) => {
  const dir = stage(t, { "sw.js": "", "cs.js": "" });
  const manifest = swManifest();
  wireBackground(dir, manifest, SHIM_FILENAME);
  applyOAuthBridge(dir, manifest, CHROME_ID);
  applyOAuthBridge(dir, manifest, CHROME_ID);
  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, BRIDGE_BACKGROUND, "sw.js"] });
  assert.equal(manifest.content_scripts.filter((cs) => cs.js.includes(BRIDGE_PAGE)).length, 1);
});

test("a module worker imports the receiver instead", (t) => {
  const dir = stage(t, { "bg/sw.js": 'import { x } from "./x.js";\nx();\n', "bg/x.js": "export const x = () => {};\n" });
  const manifest = swManifest({ background: { service_worker: "bg/sw.js", type: "module" } });
  applyOAuthBridge(dir, manifest);
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, "bg/sw.js"], type: "module" });
  assert.ok(read(dir, "bg/sw.js").startsWith(`import "../${BRIDGE_BACKGROUND}";\n`));
});

test("a background page gets the receiver as its first script", (t) => {
  const dir = stage(t, { "bg.html": '<html><head><script src="bg.js"></script></head></html>', "bg.js": "" });
  const manifest = swManifest({ background: { page: "bg.html" } });
  applyOAuthBridge(dir, manifest);
  const html = read(dir, "bg.html");
  assert.ok(html.indexOf(`/${BRIDGE_BACKGROUND}`) >= 0 && html.indexOf(`/${BRIDGE_BACKGROUND}`) < html.indexOf("bg.js"), html);
});

test("nothing is wired without externally_connectable.matches", (t) => {
  const dir = stage(t, { "sw.js": "" });
  const manifest = swManifest({ externally_connectable: { ids: ["*"] } });
  const before = JSON.stringify(manifest);
  assert.deepEqual(applyOAuthBridge(dir, manifest, CHROME_ID), []);
  assert.equal(JSON.stringify(manifest), before);
  assert.ok(!existsSync(join(dir, BRIDGE_BACKGROUND)));
});

// One window shared by the page world and the content-script world, as in a
// real tab: an event dispatched on it reaches the listeners of both. Each world
// gets its own global object whose `window` is this shared target.
function pageWindow(origin) {
  const win = new EventTarget();
  win.location = { origin, href: origin + "/login" };
  return win;
}

function world(source, globals) {
  const sandbox = { console, setTimeout, clearTimeout, Promise, JSON, URL, CustomEvent, ...globals };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

// A runtime.connect port: what one side posts arrives at the other side's
// onMessage listeners, structured-cloned, on a later turn.
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

function bridgeRuntime(t) {
  const dir = stage(t, { "sw.js": "" });
  applyOAuthBridge(dir, swManifest(), CHROME_ID);
  const origin = "https://app.example.com";
  const win = pageWindow(origin);
  const bg = fakeBrowser();
  world(read(dir, BRIDGE_BACKGROUND), { browser: bg, chrome: bg });

  // A content script's runtime.connect reaches the background's onConnect
  // listeners with the tab as the port's sender.
  const tab = { id: 42, url: origin + "/login" };
  const cs = fakeBrowser();
  const ports = [];
  cs.runtime.connect = ({ name }) => {
    const [mine, theirs] = portPair(name, { id: bg.runtime.id, url: tab.url, origin, tab, frameId: 0 });
    ports.push(theirs);
    bg.runtime.onConnect.fire(theirs);
    return mine;
  };
  world(read(dir, BRIDGE_PAGE_CS), { browser: cs, chrome: cs, window: win, location: win.location });
  world(read(dir, BRIDGE_PAGE), { window: win, location: win.location });
  return { win, bg, ports };
}

test("a matched page messages the extension's onMessageExternal listener and gets its answer", async (t) => {
  const { win, bg } = bridgeRuntime(t);
  const seen = [];
  const listener = (msg, sender, sendResponse) => { seen.push({ msg, sender }); sendResponse({ ok: true, echo: msg.type }); };
  bg.runtime.onMessageExternal.addListener(listener);
  assert.ok(bg.runtime.onMessageExternal.listeners.includes(listener), "still registered natively for real external messages");

  assert.equal(typeof win.chrome.runtime.sendMessage, "function");
  assert.equal(win.chrome.runtime.id, undefined, "Chrome exposes no extension id to web pages");
  const reply = await new Promise((resolve) => win.chrome.runtime.sendMessage(CHROME_ID, { type: "ping" }, resolve));
  assert.deepEqual(reply, { ok: true, echo: "ping" });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].msg, { type: "ping" });
  assert.equal(seen[0].sender.origin, "https://app.example.com");
  assert.equal(seen[0].sender.url, "https://app.example.com/login");
  assert.equal(seen[0].sender.tab.id, 42);
  assert.equal(seen[0].sender.id, undefined, "a web page sender has no extension id");
});

test("promise-returning listeners answer the page's promise", async (t) => {
  const { win, bg } = bridgeRuntime(t);
  bg.runtime.onMessageExternal.addListener(async (msg) => ({ token: msg.code + "!" }));
  assert.deepEqual(await win.chrome.runtime.sendMessage(CHROME_ID, { code: "x" }), { token: "x!" });
});

test("an async onMessage listener in the extension can't swallow the page's answer", async (t) => {
  const { win, bg } = bridgeRuntime(t);
  // Resolves undefined for every message; in Firefox such a promise answers runtime.sendMessage.
  bg.runtime.onMessage.addListener(async () => {});
  bg.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => { setTimeout(() => sendResponse("late but real"), 5); return true; });
  assert.equal(await win.chrome.runtime.sendMessage(CHROME_ID, {}), "late but real");
});

test("the receiver leaves the extension's own ports alone", async (t) => {
  const { bg } = bridgeRuntime(t);
  const [, port] = portPair("popup", { id: bg.runtime.id });
  let disconnected = false;
  port.disconnect = () => { disconnected = true; };
  bg.runtime.onConnect.fire(port);
  assert.equal(port.onMessage.listeners.length, 0);
  assert.equal(disconnected, false);
  await tick();
});
