import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// Chrome lets another extension message an add-on that declares
// externally_connectable only when `ids` lists it ("*" for all; none without
// ids). Firefox has no such key: every installed add-on reached the converted
// add-on's onMessageExternal and onConnectExternal listeners.

const ALLOWED = "abcdefghijklmnopabcdefghijklmnop";

function background(externalIds) {
  const browser = fakeBrowser();
  browser.runtime.onConnectExternal = (() => {
    const listeners = [];
    return { listeners, addListener: (fn) => listeners.push(fn), removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1), hasListener: (fn) => listeners.includes(fn), fire: (...a) => listeners.map((fn) => fn(...a)) };
  })();
  const ctx = runInContext(buildShim({ externalIds }), { browser });
  vm.runInContext(`
    globalThis.heard = [];
    globalThis.onMsg = (m, sender) => { heard.push(sender.id); return true; };
    chrome.runtime.onMessageExternal.addListener(onMsg);
    chrome.runtime.onConnectExternal.addListener((port) => heard.push("port:" + port.sender.id));
  `, ctx);
  return { ctx, browser };
}

function send(browser, id) {
  return browser.runtime.onMessageExternal.fire({ hi: 1 }, { id }, () => {});
}

test("only the extensions externally_connectable lists get through", () => {
  const { ctx, browser } = background([ALLOWED]);
  send(browser, "evil@example.com");
  assert.deepEqual(send(browser, ALLOWED), [true], "the listener's answer still reaches Firefox");
  // The same extension converted by lavaduct carries its Chrome ID in its add-on ID.
  send(browser, `${ALLOWED}.1a2b3c4d@lavaduct`);
  send(browser, `${ALLOWED}x.1a2b3c4d@lavaduct`);
  let disconnected = false;
  browser.runtime.onConnectExternal.fire({ sender: { id: "evil@example.com" }, disconnect() { disconnected = true; } });
  browser.runtime.onConnectExternal.fire({ sender: { id: ALLOWED }, disconnect() {} });
  assert.deepEqual([...ctx.heard], [ALLOWED, `${ALLOWED}.1a2b3c4d@lavaduct`, "port:" + ALLOWED]);
  assert.equal(disconnected, true, "a port Chrome would refuse is closed");

  assert.equal(vm.runInContext("chrome.runtime.onMessageExternal.hasListener(onMsg)", ctx), true);
  vm.runInContext("chrome.runtime.onMessageExternal.removeListener(onMsg)", ctx);
  assert.equal(browser.runtime.onMessageExternal.listeners.length, 0);
});

test("externally_connectable without ids lets no extension in, and \"*\" lets every one in", () => {
  const none = background([]);
  send(none.browser, ALLOWED);
  assert.deepEqual([...none.ctx.heard], []);
  const all = background(["*"]);
  send(all.browser, "someone@example.com");
  assert.deepEqual([...all.ctx.heard], ["someone@example.com"]);
});

test("without externally_connectable, Firefox's events are left as they are", () => {
  const browser = fakeBrowser();
  const add = browser.runtime.onMessageExternal.addListener;
  runInContext(buildShim({}), { browser });
  assert.equal(browser.runtime.onMessageExternal.addListener, add);
});
