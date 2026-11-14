import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// Firefox's declarativeNetRequest has no setExtensionActionOptions (Firefox
// can't show matched-rule counts on the toolbar button), so calling it throws
// "setExtensionActionOptions is not a function". Chrome builds call it in
// their install and update handlers, usually to turn the count off:
// Malwarebytes Browser Guard awaits it in onInstalled and lost the steps after
// it (its uninstall URL, and on update its badge colour and its stale dynamic
// rules) to an unhandled rejection.

function context(dnr) {
  return runInContext(buildShim(), { browser: fakeBrowser({ extra: { declarativeNetRequest: dnr } }) });
}

test("setExtensionActionOptions settles, by promise or callback, so the code after it runs", async () => {
  const ctx = context({ updateDynamicRules: () => Promise.resolve() });
  const out = await vm.runInContext(`(async () => {
    const r = await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: false });
    const viaCallback = await new Promise((resolve) => chrome.declarativeNetRequest.setExtensionActionOptions({ tabUpdate: { tabId: 1, increment: 1 } }, () => resolve("called")));
    return [r, viaCallback];
  })()`, ctx);
  assert.deepEqual([...out], [undefined, "called"]);
});

test("Firefox's own setExtensionActionOptions is kept", () => {
  const own = () => Promise.resolve("firefox");
  const dnr = { setExtensionActionOptions: own };
  context(dnr);
  assert.equal(dnr.setExtensionActionOptions, own);
});
