import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";

// Chrome's ContextFilter takes `incognito` as a boolean. The offscreen
// document the shim appends to getContexts is never incognito, so a filter
// asking for incognito contexts must leave it out.

test("getContexts({ incognito: true }) leaves out the emulated offscreen document", async () => {
  const shim = buildShim({}, { "bg.js": "chrome.offscreen.createDocument({ url: 'off.html' })" });
  const browser = fakeBrowser();
  browser.runtime.getContexts = () => Promise.resolve([]);
  await browser.storage.session.set({ __lavaductOffscreenDocument: EXT_ORIGIN + "/off.html" });
  const ctx = runInContext(shim, { browser, href: EXT_ORIGIN + "/popup.html" });

  const incognito = plain(await vm.runInContext("chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], incognito: true })", ctx));
  assert.deepEqual(incognito, []);
  const regular = plain(await vm.runInContext("chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], incognito: false })", ctx));
  assert.deepEqual(regular.map((c) => c.contextType), ["OFFSCREEN_DOCUMENT"]);
});
