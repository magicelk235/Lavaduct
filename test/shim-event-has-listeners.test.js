import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, makeEvent, runInContext } from "./shim-sandbox.js";

// Chrome's events have hasListeners(), true when the event has any listener in
// this context; Firefox's have addListener, removeListener and hasListener(fn)
// only. Brisk's Datadog content script calls chrome.runtime.onMessage.hasListeners()
// at top level and died on "hasListeners is not a function"; Norton's and Avira's
// password managers call chrome.windows.onRemoved.hasListeners() and
// chrome.history.onVisited.hasListeners() before removing a listener.

const BRISK = "if(!chrome.runtime.onMessage.hasListeners())chrome.runtime.onMessage.addListener(onMsg);";

function setup(bundle) {
  const browser = fakeBrowser();
  browser.windows.onRemoved = makeEvent();
  browser.history = { onVisited: makeEvent() };
  const own = { listeners: [], addListener() {}, removeListener() {}, hasListener() { return false; }, hasListeners() { return "own"; } };
  browser.tabs.onUpdated = own;
  const ctx = runInContext(buildShim({}, { "cs.js": bundle }), { browser });
  return { browser, ctx, own };
}

test("every event answers hasListeners() for the listeners added in this context", () => {
  const { browser, ctx } = setup(BRISK);
  for (const ev of ["chrome.runtime.onMessage", "chrome.windows.onRemoved", "browser.history.onVisited"]) {
    vm.runInContext(`globalThis.f = function () {}; globalThis.g = function () {};`, ctx);
    assert.equal(vm.runInContext(`${ev}.hasListeners()`, ctx), false, ev);
    vm.runInContext(`${ev}.addListener(f); ${ev}.addListener(g);`, ctx);
    assert.equal(vm.runInContext(`${ev}.hasListeners()`, ctx), true, ev);
    assert.equal(vm.runInContext(`${ev}.hasListener(f)`, ctx), true, `${ev}: hasListener still finds it`);
    vm.runInContext(`${ev}.removeListener(f)`, ctx);
    assert.equal(vm.runInContext(`${ev}.hasListeners()`, ctx), true, `${ev}: g is still there`);
    vm.runInContext(`${ev}.removeListener(g)`, ctx);
    assert.equal(vm.runInContext(`${ev}.hasListeners()`, ctx), false, ev);
  }
  // The add-on's function itself is what Firefox holds.
  vm.runInContext("chrome.windows.onRemoved.addListener(f)", ctx);
  assert.deepEqual(browser.windows.onRemoved.listeners, [ctx.f]);
});

test("an event that has hasListeners keeps its own, and a bundle that never calls it gets none", () => {
  const { ctx, own } = setup(BRISK);
  assert.equal(vm.runInContext("chrome.tabs.onUpdated.hasListeners", ctx), own.hasListeners);
  const plain = setup("chrome.runtime.onMessage.addListener(onMsg);");
  assert.equal(vm.runInContext("typeof chrome.runtime.onMessage.hasListeners", plain.ctx), "undefined");
  assert.equal(vm.runInContext("chrome.windows.onRemoved.addListener", plain.ctx), plain.browser.windows.onRemoved.addListener);
});

// The falsy-filter shim (a bundle passing addListener(fn, false)) wraps the same
// addListener; both apply.
test("hasListeners counts a listener another wrapper of addListener passed on", () => {
  const browser = fakeBrowser();
  browser.tabs.onCreated = makeEvent();
  const ctx = runInContext(buildShim({}, { "cs.js": BRISK + "chrome.tabs.onCreated.addListener(f,!1);" }), { browser });
  vm.runInContext("globalThis.f = function () {}; chrome.tabs.onCreated.addListener(f, false);", ctx);
  assert.deepEqual(browser.tabs.onCreated.listeners, [ctx.f], "the false filter is dropped, the function kept");
  assert.equal(vm.runInContext("chrome.tabs.onCreated.hasListeners()", ctx), true);
  vm.runInContext("chrome.tabs.onCreated.removeListener(f)", ctx);
  assert.equal(vm.runInContext("chrome.tabs.onCreated.hasListeners()", ctx), false);
});
