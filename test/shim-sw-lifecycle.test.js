import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, makeLocalStorage, runInContext, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Chrome installs an extension's service worker on install and update: its
// script runs, then `install` and `activate` fire. Workers boot from them and
// call skipWaiting() in them:
//   self.addEventListener("install", boot)                      (MetaMask)
//   const { skipWaiting: t } = globalThis; globalThis.oninstall = () => t();   (Tampermonkey)
// The converted background is an event page that gets neither event and has no
// skipWaiting, so boot never ran and the handlers threw.

const WORKER = `
  globalThis.log = [];
  const { skipWaiting: sw } = globalThis;
  self.addEventListener("install", (e) => { log.push("install"); e.waitUntil(sw().then(() => log.push("skipped"))); });
  self.onactivate = (e) => { log.push("activate"); };
`;

function background(shim, { localStorage = makeLocalStorage(), version = "1.0" } = {}) {
  const target = new EventTarget();
  const browser = fakeBrowser({ manifest: { manifest_version: 3, name: "T", version } });
  const ctx = runInContext(shim, {
    browser,
    globals: {
      localStorage,
      Event,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    },
  });
  vm.runInContext(WORKER, ctx);
  return ctx;
}

const shim = buildShim({ serviceWorker: true }, { "sw.js": WORKER });

test("install and then activate reach the worker once per version, after its scripts ran", async () => {
  const store = makeLocalStorage();
  let ctx = background(shim, { localStorage: store });
  await tick(10);
  assert.deepEqual([...ctx.log], ["install", "skipped", "activate"]);

  // The event page wakes again: same version, no events.
  ctx = background(shim, { localStorage: store });
  await tick(10);
  assert.deepEqual([...ctx.log], []);

  // An update installs the worker again.
  ctx = background(shim, { localStorage: store, version: "1.1" });
  await tick(10);
  assert.deepEqual([...ctx.log], ["install", "skipped", "activate"]);
});

test("skipWaiting is there for a worker that calls it, and only in the background", async () => {
  const bundle = { "sw.js": "self.skipWaiting();" };
  const built = buildShim({ serviceWorker: true }, bundle);
  const ctx = runInContext(built, { browser: fakeBrowser() });
  assert.equal(typeof ctx.skipWaiting, "function");
  assert.equal(typeof ctx.skipWaiting().then, "function");
  const page = runInContext(built, { browser: fakeBrowser(), href: EXT_ORIGIN + "/popup.html" });
  assert.equal(typeof page.skipWaiting, "undefined");
});

test("a background that never was a worker, or never listens, gets nothing", () => {
  for (const s of [buildShim({ serviceWorker: false }, { "sw.js": WORKER }), buildShim({ serviceWorker: true }, { "sw.js": "chrome.runtime.onMessage.addListener(() => {});" })]) {
    const ctx = runInContext(s, { browser: fakeBrowser(), globals: { localStorage: makeLocalStorage() } });
    assert.equal(typeof ctx.skipWaiting, "undefined");
    assert.equal("oninstall" in ctx, false);
  }
});
