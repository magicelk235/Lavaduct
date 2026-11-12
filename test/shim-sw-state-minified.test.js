import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// MetaMask's worker boots only from its `install` event or, on a restart, when
// it finds itself already active. Minified, the check reads the worker through
// an alias of `self`:
//   a.addEventListener("install", o), ... , "activated" === a.serviceWorker.state && o()
// An event page has no `self.serviceWorker`, so the read throws, `o()` never runs
// and the add-on's pages report "Background connection unresponsive". The bundle
// also carries Firebase's web push code (`.pushManager`), which only rules out
// the registration: the worker object has no push to pick.

const BOOT = { "service-worker.js": 'var a = self; a.addEventListener("install", o); "activated" === a.serviceWorker.state && o();' };
const config = { serviceWorker: true, serviceWorkerScript: "service-worker.js" };
const globals = { EventTarget, MessageEvent };

test("a minified worker that reads its own state through an alias of self finds itself activated", () => {
  const ctx = runInContext(buildShim(config, BOOT), { browser: fakeBrowser(), globals });
  assert.equal(vm.runInContext("self.serviceWorker.state", ctx), "activated");
  assert.equal(vm.runInContext("self.serviceWorker.scriptURL", ctx), EXT_ORIGIN + "/service-worker.js");
});

test("a bundle with web push code still gets its worker's state, but no registration", () => {
  const files = { ...BOOT, "8693.js": "let n = await e.swRegistration.pushManager.getSubscription();" };
  const ctx = runInContext(buildShim(config, files), { browser: fakeBrowser(), globals });
  assert.equal(vm.runInContext("self.serviceWorker.state", ctx), "activated");
  assert.equal(vm.runInContext("typeof self.registration", ctx), "undefined", "Firefox gives add-ons no Push API");
});

test("the worker's state is only stood in for in a background that was a worker", () => {
  const ctx = runInContext(buildShim({ serviceWorker: false }, BOOT), { browser: fakeBrowser(), globals });
  assert.equal(vm.runInContext("typeof self.serviceWorker", ctx), "undefined");
  const page = runInContext(buildShim(config, BOOT), { browser: fakeBrowser(), href: EXT_ORIGIN + "/popup.html", globals });
  assert.equal(vm.runInContext("typeof self.serviceWorker", page), "undefined");
});
