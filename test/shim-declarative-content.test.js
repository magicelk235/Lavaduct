import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, makeEvent, makeLocalStorage, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Firefox has no chrome.declarativeContent. Chrome extension source viewer
// registers its rules in onInstalled and only then disables its button for all
// tabs; Tactiq does the rest of its install setup after addRules. Both threw on
// the first declarativeContent call (measured in Firefox 160).

const SOURCE_VIEWER = `
  chrome.runtime.onInstalled.addListener(() => {
    if (!chrome.declarativeContent.ShowAction) chrome.declarativeContent.ShowAction = chrome.declarativeContent.ShowPageAction;
    chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
      chrome.declarativeContent.onPageChanged.addRules([{
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: "chromewebstore.google.com", pathPrefix: "/detail/" } }),
          new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostSuffix: "addons.mozilla.org", pathContains: "addon/" } }),
        ],
        actions: [new chrome.declarativeContent.ShowAction()],
      }], () => { chrome.action.disable(); globalThis.registered = true; });
    });
  });
`;

function firefoxAction(log) {
  let global = true;
  const perTab = {};
  return {
    perTab,
    enable: (tabId) => { if (tabId == null) global = true; else perTab[tabId] = true; log.push(["enable", tabId]); return Promise.resolve(); },
    disable: (tabId) => { if (tabId == null) global = false; else perTab[tabId] = false; log.push(["disable", tabId]); return Promise.resolve(); },
    isEnabled: (d) => Promise.resolve(d && d.tabId != null && d.tabId in perTab ? perTab[d.tabId] : global),
    setIcon: (d) => { log.push(["setIcon", d]); return Promise.resolve(); },
  };
}

function background({ permissions = ["declarativeContent", "tabs"], tabs = [], localStorage = makeLocalStorage(), code = SOURCE_VIEWER } = {}) {
  const log = [];
  const browser = fakeBrowser();
  browser.runtime.onInstalled = makeEvent();
  browser.action = firefoxAction(log);
  browser.tabs = { query: () => Promise.resolve(tabs), onUpdated: makeEvent(), onRemoved: makeEvent() };
  browser.scripting = { executeScript: (d) => { log.push(["executeScript", d]); return Promise.resolve([{ result: true }]); }, insertCSS: (d) => { log.push(["insertCSS", d]); return Promise.resolve(); } };
  const ctx = runInContext(buildShim({ declaredPermissions: permissions }, { "bg.js": code }), { browser, globals: { localStorage } });
  vm.runInContext(code, ctx);
  return { ctx, browser, log, localStorage };
}

const STORE = { id: 1, url: "https://chromewebstore.google.com/detail/abc" };
const AMO = { id: 2, url: "https://addons.mozilla.org/en-US/firefox/addon/x/" };
const OTHER = { id: 3, url: "https://example.com/detail/abc" };

test("the action is enabled only on pages a ShowAction rule matches", async () => {
  const { ctx, browser } = background({ tabs: [STORE, AMO, OTHER] });
  browser.runtime.onInstalled.fire({ reason: "install" });
  await tick(20);
  assert.equal(ctx.registered, true, "onInstalled ran to its end");
  const { perTab } = browser.action;
  assert.deepEqual(plain(perTab), { 1: true, 2: true });
  assert.equal(await browser.action.isEnabled({ tabId: OTHER.id }), false, "everywhere else the add-on's own disable() holds");

  // Navigating away from a matching page puts the tab back to the add-on's setting.
  browser.tabs.onUpdated.fire(1, { url: OTHER.url, status: "complete" }, { id: 1, url: OTHER.url });
  await tick(10);
  assert.equal(perTab[1], false);
  browser.tabs.onUpdated.fire(3, { status: "complete" }, { id: 3, url: STORE.url });
  await tick(10);
  assert.equal(perTab[3], true);
});

test("rules outlive the event page, and getRules lists them", async () => {
  const store = makeLocalStorage();
  const first = background({ localStorage: store });
  first.browser.runtime.onInstalled.fire({ reason: "install" });
  await tick(20);
  const again = background({ localStorage: store, tabs: [STORE], code: "void chrome.declarativeContent;" });
  await tick(20);
  assert.deepEqual(plain(again.browser.action.perTab), { 1: true });
  const rules = await vm.runInContext("chrome.declarativeContent.onPageChanged.getRules()", again.ctx);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].actions[0].instanceType, "declarativeContent.ShowAction");
});

test("css conditions are checked in the page, and RequestContentScript injects once per page", async () => {
  const code = `chrome.declarativeContent.onPageChanged.addRules([{
    conditions: [new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostSuffix: ".zoom.us" }, css: ["video"] })],
    actions: [new chrome.declarativeContent.RequestContentScript({ js: ["rtc.js"] })],
  }]);`;
  const { log, browser } = background({ code, tabs: [{ id: 5, url: "https://us02web.zoom.us/j/1" }] });
  await tick(20);
  browser.tabs.onUpdated.fire(5, { status: "complete" }, { id: 5, url: "https://us02web.zoom.us/j/1" });
  await tick(20);
  const execs = log.filter((l) => l[0] === "executeScript").map((l) => l[1]);
  assert.equal(typeof execs[0].func, "function", "the selectors are looked up in the page");
  assert.deepEqual(plain(execs.filter((d) => d.files).map((d) => d.files)), [["rtc.js"]]);
});

test("an add-on without the permission, or code that never uses it, gets no declarativeContent", () => {
  const without = background({ permissions: ["tabs"] });
  assert.equal(vm.runInContext("typeof chrome.declarativeContent", without.ctx), "undefined");
  const page = runInContext(buildShim({ declaredPermissions: ["declarativeContent"] }, { "a.js": "x" }), { browser: fakeBrowser(), href: EXT_ORIGIN + "/popup.html" });
  assert.equal(vm.runInContext("typeof chrome.declarativeContent", page), "undefined");
});
