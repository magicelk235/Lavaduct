import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// A Chrome background is a service worker, and Claude in Chrome (among others)
// routes work on `"ServiceWorkerGlobalScope" in globalThis`: the worker refreshes
// tokens itself, pages ask it over messaging. The converted background is an
// event page, so it must answer yes there, and only there.

const ASKS = { "sw.js": 'if ("ServiceWorkerGlobalScope" in globalThis) refresh(); else ask();' };
const probe = 'JSON.stringify(["ServiceWorkerGlobalScope" in globalThis, typeof ServiceWorkerGlobalScope === "function" && self instanceof ServiceWorkerGlobalScope])';

function answer(shim, href) {
  const ctx = runInContext(shim, { browser: fakeBrowser(), href });
  return JSON.parse(vm.runInContext(probe, ctx));
}

test("the converted background is a service worker scope; the add-on's pages and content scripts aren't", () => {
  const shim = buildShim({ serviceWorker: true }, ASKS);
  assert.deepEqual(answer(shim, EXT_ORIGIN + "/_generated_background_page.html"), [true, true]);
  assert.deepEqual(answer(shim, EXT_ORIGIN + "/sidepanel.html"), [false, false]);
  assert.deepEqual(answer(shim, "https://example.com/"), [false, false]);

  const ctx = runInContext(shim, { browser: fakeBrowser() });
  assert.equal(vm.runInContext("({}) instanceof ServiceWorkerGlobalScope", ctx), false, "only the global itself is the scope");
  assert.throws(() => vm.runInContext("new ServiceWorkerGlobalScope()", ctx), { name: "TypeError" });
});

test("a background that never was a worker, or code that never asks, is left alone", () => {
  assert.deepEqual(answer(buildShim({ serviceWorker: false }, ASKS), EXT_ORIGIN + "/_generated_background_page.html"), [false, false]);
  assert.deepEqual(answer(buildShim({ serviceWorker: true }, { "sw.js": "chrome.runtime.onMessage.addListener(() => {});" }), EXT_ORIGIN + "/_generated_background_page.html"), [false, false]);
});
