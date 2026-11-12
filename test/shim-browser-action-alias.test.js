import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, makeEvent, runInContext } from "./shim-sandbox.js";

// Firefox gives an MV3 add-on `action` and no `browserAction` (measured in
// Firefox 160), as Chrome does. A Chrome MV3 bundle that also ships to Firefox
// as MV2 picks its Firefox branch by sniffing the user agent, and that branch
// reads browserAction. Web Scraper 1.111.13's background ran
// `chrome.browserAction.onClicked.addListener(() => chrome.sidebarAction.open())`
// there: the read threw, startup ended in an unhandled rejection, and its
// toolbar button did nothing (Chrome opens its side panel instead).

const WEB_SCRAPER = "static initFirefoxSidebarAction(){const e=chrome.sidebarAction;chrome.browserAction.onClicked.addListener(()=>e.open())}";

function setup(bundle, { manifest } = {}) {
  const browser = fakeBrowser(manifest ? { manifest } : {});
  browser.action = { onClicked: makeEvent(), setBadgeText: () => Promise.resolve() };
  const ctx = runInContext(buildShim({}, { "background.js": bundle }), { browser });
  return { browser, ctx };
}

test("an MV3 bundle that uses browserAction gets Firefox's action under that name", () => {
  const { browser, ctx } = setup(WEB_SCRAPER);
  assert.equal(vm.runInContext("chrome.browserAction", ctx), browser.action);
  vm.runInContext("globalThis.f = () => {}; chrome.browserAction.onClicked.addListener(f);", ctx);
  assert.deepEqual(browser.action.onClicked.listeners, [ctx.f]);
});

test("Firefox's own browserAction (MV2) is kept", () => {
  const browser = fakeBrowser({ manifest: { manifest_version: 2, name: "T", version: "1" } });
  const own = { onClicked: makeEvent() };
  browser.browserAction = own;
  runInContext(buildShim({}, { "background.js": WEB_SCRAPER }), { browser });
  assert.equal(browser.browserAction, own);
  assert.equal(browser.action, undefined);
});

test("no action, no alias: a page without the toolbar button stays as Firefox made it", () => {
  const browser = fakeBrowser();
  runInContext(buildShim({}, { "background.js": WEB_SCRAPER }), { browser });
  assert.equal("browserAction" in browser, false);
});

test("a bundle that never touches browserAction gets no alias", () => {
  const { browser } = setup('chrome.action.onClicked.addListener(() => {}); const m = { browserActions_running: "x" }; const meta = { browserAction: { disable: {} } };');
  assert.equal("browserAction" in browser, false);
});
