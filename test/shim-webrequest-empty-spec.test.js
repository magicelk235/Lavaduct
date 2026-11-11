import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// Chrome takes an extraInfoSpec on every webRequest event, onErrorOccurred
// included (its only value is "extraHeaders"), and a missing one passed as
// undefined. Firefox's onErrorOccurred has no such parameter: a third argument,
// even undefined or [], throws "Incorrect argument types for
// webRequest.onErrorOccurred" (measured in Firefox 159). AdGuard registers every
// event through one helper, `event.addListener(handler, filter, extraInfoSpec)`,
// so once "extraHeaders" is dropped its onErrorOccurred listener still threw
// and its engine still didn't start.

function noSpecEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn, filter) {
      if (arguments.length > 2) throw new TypeError("Incorrect argument types for webRequest.onErrorOccurred.");
      listeners.push({ fn, filter });
    },
    removeListener(fn) { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.some((l) => l.fn === fn); },
  };
}

test("an undefined, empty or emptied extraInfoSpec isn't passed on", () => {
  const browser = fakeBrowser();
  browser.webRequest = { onErrorOccurred: noSpecEvent() };
  const ctx = runInContext(buildShim({}, { "bg.js": "const o = ['extraHeaders'];" }), { browser });
  vm.runInContext(`
    globalThis.a = () => {}; globalThis.b = () => {}; globalThis.c = () => {};
    chrome.webRequest.onErrorOccurred.addListener(a, { urls: ["<all_urls>"] }, undefined);
    chrome.webRequest.onErrorOccurred.addListener(b, { urls: ["<all_urls>"] }, []);
    chrome.webRequest.onErrorOccurred.addListener(c, { urls: ["<all_urls>"] }, ["extraHeaders"]);
  `, ctx);
  assert.deepEqual(browser.webRequest.onErrorOccurred.listeners.map((l) => l.fn), [ctx.a, ctx.b, ctx.c]);
  assert.equal(vm.runInContext("chrome.webRequest.onErrorOccurred.hasListener(c)", ctx), true);
});
