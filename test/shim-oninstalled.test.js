import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, makeEvent, makeLocalStorage, plain, runInContext } from "./shim-sandbox.js";

// An add-on loaded temporarily at every Firefox start hears from Firefox each
// time that it was just installed. Extensions open their welcome page on that,
// so without the shim one would open at every start.

/** Start the background once, as one Firefox session does, and return what its onInstalled listener saw. */
function start(storage, version, details) {
  const browser = fakeBrowser({ manifest: { manifest_version: 3, name: "T", version }, extra: {} });
  browser.runtime.onInstalled = makeEvent();
  const ctx = runInContext(buildShim(), { browser, globals: { localStorage: storage } });
  vm.runInContext("var seen = []; chrome.runtime.onInstalled.addListener((d) => seen.push(d));", ctx);
  browser.runtime.onInstalled.fire(details);
  return plain(ctx.seen);
}

test("the first temporary load is an install, and later ones of the same version look like a browser update", () => {
  const storage = makeLocalStorage();
  assert.deepEqual(start(storage, "1.0", { reason: "install", temporary: true }), [{ reason: "install", temporary: true }]);
  assert.deepEqual(start(storage, "1.0", { reason: "install", temporary: true }), [{ reason: "chrome_update", temporary: true }]);
  assert.deepEqual(start(storage, "1.0", { reason: "install", temporary: true }), [{ reason: "chrome_update", temporary: true }]);
});

test("a temporary load of a new version is an update from the version before", () => {
  const storage = makeLocalStorage();
  start(storage, "1.0", { reason: "install", temporary: true });
  assert.deepEqual(start(storage, "1.1", { reason: "install", temporary: true }), [
    { reason: "update", temporary: true, previousVersion: "1.0" },
  ]);
  assert.deepEqual(start(storage, "1.1", { reason: "install", temporary: true }), [{ reason: "chrome_update", temporary: true }]);
});

test("events of an add-on that isn't loaded temporarily pass unchanged", () => {
  const storage = makeLocalStorage();
  start(storage, "1.0", { reason: "install", temporary: true });
  assert.deepEqual(start(storage, "1.0", { reason: "install" }), [{ reason: "install" }]);
  assert.deepEqual(start(storage, "2.0", { reason: "update", previousVersion: "1.0" }), [{ reason: "update", previousVersion: "1.0" }]);
});

test("a listener removed by the function it was added with stops getting the event", () => {
  const browser = fakeBrowser();
  browser.runtime.onInstalled = makeEvent();
  const ctx = runInContext(buildShim(), { browser, globals: { localStorage: makeLocalStorage() } });
  vm.runInContext(
    "var calls = 0; var fn = () => calls++; chrome.runtime.onInstalled.addListener(fn);" +
      "var had = chrome.runtime.onInstalled.hasListener(fn); chrome.runtime.onInstalled.removeListener(fn);",
    ctx,
  );
  browser.runtime.onInstalled.fire({ reason: "install", temporary: true });
  assert.equal(ctx.had, true);
  assert.equal(ctx.calls, 0);
  assert.equal(browser.runtime.onInstalled.listeners.length, 0);
});
