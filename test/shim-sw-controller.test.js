import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// Chrome's background worker controls the add-on's pages, and pages post to it
// through navigator.serviceWorker.controller. Dashlane's vault uploads files
// that way and throws "No service worker available" when it is null. Only a
// worker that answers fetches must look absent, since the event page can't.

function page(files) {
  return runInContext(buildShim({ serviceWorker: true, serviceWorkerScript: "sw.js" }, files), {
    browser: fakeBrowser(),
    href: EXT_ORIGIN + "/vault.html",
    globals: { navigator: {}, document: { readyState: "complete", addEventListener() {} }, EventTarget, MessageEvent, addEventListener() {} },
  });
}

const PAGE = { "vault.js": "navigator.serviceWorker.controller.postMessage(m, [m.content])" };

test("a worker without a fetch handler controls the add-on's pages", async () => {
  const ctx = page({ ...PAGE, "sw.js": 'importScripts("lib/a.js"); self.onmessage = f;', "lib/a.js": "x()" });
  const reg = await vm.runInContext("navigator.serviceWorker.ready", ctx);
  assert.equal(vm.runInContext("navigator.serviceWorker.controller", ctx), reg.active);
  assert.equal(vm.runInContext("navigator.serviceWorker.controller.scriptURL", ctx), EXT_ORIGIN + "/sw.js");
});

test("a worker that handles fetch, itself or in a script it imports, controls none", () => {
  for (const files of [
    { "sw.js": 'self.addEventListener("fetch", serve)' },
    { "sw.js": "self.onfetch = serve" },
    { "sw.js": 'importScripts("lib/net.js")', "lib/net.js": 'addEventListener("fetch", serve)' },
    { "sw.js": 'importScripts(chrome.runtime.getURL("net.js"))', "net.js": 'addEventListener("fetch", serve)' },
    { "sw.js": 'import "./net.js";', "net.js": "self.onfetch = serve" },
  ]) {
    assert.equal(vm.runInContext("navigator.serviceWorker.controller", page({ ...PAGE, ...files })), null, Object.keys(files).join(","));
  }
});
