import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// Loom's bundles decide whether they run in the background worker by resolving the
// manifest's worker script against their own location:
//   new URL(chrome.runtime.getManifest()?.background?.service_worker, location.origin).pathname === location.pathname
// The converted manifest Firefox returns has background.scripts and no service_worker,
// and the event page's location is /_generated_background_page.html, so the background
// concluded it wasn't the worker and sent its metrics and logs with
// runtime.sendMessage to itself: "Receiving end does not exist", dozens of times a run.
const LOOM_CHECK =
  "(function (e) { try { var p = new URL(e, location.origin).pathname; return p === location.pathname; } catch (x) { return false; } })(chrome.runtime.getManifest()?.background?.service_worker)";
const FIREFOX_MANIFEST = { manifest_version: 3, name: "T", version: "1", background: { scripts: ["lavaduct-compat-shim.js", "js/sw.js"] } };
const WORKER = { serviceWorker: true, serviceWorkerScript: "js/sw.js" };
const FILES = { "js/sw.js": `var isWorker = () => ${LOOM_CHECK};` };

// Node's URL gives a moz-extension: URL the origin "null"; Firefox's location doesn't.
function run(config, files, opts) {
  const ctx = runInContext(buildShim(config, files), opts);
  if (ctx.location.protocol === "moz-extension:") ctx.location.origin = EXT_ORIGIN;
  return ctx;
}

test("the background of a converted worker finds itself as the manifest's service_worker", () => {
  const ctx = run(WORKER, FILES, { browser: fakeBrowser({ manifest: FIREFOX_MANIFEST }) });
  assert.equal(vm.runInContext(LOOM_CHECK, ctx), true);
  assert.equal(
    vm.runInContext("location.href === chrome.runtime.getURL(chrome.runtime.getManifest().background.service_worker)", ctx),
    true,
  );
  assert.deepEqual([...vm.runInContext("chrome.runtime.getManifest().background.scripts", ctx)], FIREFOX_MANIFEST.background.scripts);
});

test("the add-on's pages and content scripts see the worker script, so their check still says no", () => {
  for (const href of [EXT_ORIGIN + "/popup.html", "https://example.com/js/page.html"]) {
    const ctx = run(WORKER, FILES, { browser: fakeBrowser({ manifest: FIREFOX_MANIFEST }), href });
    assert.equal(vm.runInContext("chrome.runtime.getManifest().background.service_worker", ctx), "js/sw.js", href);
    assert.equal(vm.runInContext(LOOM_CHECK, ctx), false, href);
  }
});

test("getManifest is left alone when no script reads service_worker or the background wasn't a worker", () => {
  for (const [config, files] of [[WORKER, { "js/sw.js": "chrome.runtime.getManifest().version" }], [{}, FILES]]) {
    const browser = fakeBrowser({ manifest: FIREFOX_MANIFEST });
    const native = browser.runtime.getManifest;
    runInContext(buildShim(config, files), { browser });
    assert.equal(browser.runtime.getManifest, native);
  }
});

test("a service_worker the manifest already has is kept", () => {
  const manifest = { ...FIREFOX_MANIFEST, background: { service_worker: "kept.js" } };
  const ctx = run(WORKER, FILES, { browser: fakeBrowser({ manifest }) });
  assert.equal(vm.runInContext("chrome.runtime.getManifest().background.service_worker", ctx), "kept.js");
});

test("the manifest object Firefox returned is not modified", () => {
  const manifest = structuredClone(FIREFOX_MANIFEST);
  const ctx = run(WORKER, FILES, { browser: fakeBrowser({ manifest }) });
  vm.runInContext("chrome.runtime.getManifest()", ctx);
  assert.deepEqual(manifest, FIREFOX_MANIFEST);
});
