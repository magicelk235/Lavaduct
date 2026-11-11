import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// Chrome needs "extraHeaders" in a webRequest listener's extraInfoSpec to show
// some headers; Firefox shows them all and has no such value, so it refuses the
// listener: `Invalid enumeration value "extraHeaders"` (measured in Firefox
// 159 for onResponseStarted and onBeforeSendHeaders). AdGuard adds it
// unconditionally for onResponseStarted, and its filtering engine never starts.

const SPEC_VALUES = new Set(["blocking", "asyncBlocking", "requestHeaders", "responseHeaders", "requestBody"]);

function firefoxEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn, filter, spec) {
      for (const [i, v] of (spec || []).entries()) {
        if (!SPEC_VALUES.has(v)) throw new TypeError(`Type error for parameter extraInfoSpec (Error processing ${i}: Invalid enumeration value "${v}")`);
      }
      listeners.push({ fn, filter, spec });
    },
    removeListener(fn) { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.some((l) => l.fn === fn); },
  };
}

function setup(code) {
  const browser = fakeBrowser();
  browser.webRequest = { onResponseStarted: firefoxEvent(), onBeforeSendHeaders: firefoxEvent(), ResourceType: { MAIN_FRAME: "main_frame" } };
  const native = browser.webRequest.onResponseStarted.addListener;
  const ctx = runInContext(buildShim({}, { "bg.js": code }), { browser });
  return { browser, ctx, native };
}

test('a webRequest listener asking for "extraHeaders" is added without it, and stays removable', () => {
  const { browser, ctx } = setup("const opts = ['responseHeaders', 'extraHeaders'];");
  vm.runInContext(`
    globalThis.spec = Object.freeze(["responseHeaders", "extraHeaders"]);
    globalThis.onStarted = () => {};
    chrome.webRequest.onResponseStarted.addListener(onStarted, { urls: ["<all_urls>"] }, spec);
    chrome.webRequest.onBeforeSendHeaders.addListener(onStarted, { urls: ["<all_urls>"] }, ["blocking", "requestHeaders", "extraHeaders"]);
  `, ctx);
  const [added] = browser.webRequest.onResponseStarted.listeners;
  assert.equal(added.fn, ctx.onStarted, "the add-on's own function is the listener");
  assert.deepEqual([...added.spec], ["responseHeaders"]);
  assert.deepEqual([...browser.webRequest.onBeforeSendHeaders.listeners[0].spec], ["blocking", "requestHeaders"]);
  assert.deepEqual([...ctx.spec], ["responseHeaders", "extraHeaders"], "the add-on's array is left alone");
  assert.equal(vm.runInContext("chrome.webRequest.onResponseStarted.hasListener(onStarted)", ctx), true);
  vm.runInContext("chrome.webRequest.onResponseStarted.removeListener(onStarted)", ctx);
  assert.equal(browser.webRequest.onResponseStarted.listeners.length, 0);
});

test("a bundle that never names extraHeaders keeps Firefox's addListener", () => {
  const { browser, native } = setup("chrome.webRequest.onResponseStarted.addListener(() => {}, { urls: ['<all_urls>'] });");
  assert.equal(browser.webRequest.onResponseStarted.addListener, native);
});
