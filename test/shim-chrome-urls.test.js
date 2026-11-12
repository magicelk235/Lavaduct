import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Firefox's tabs.create, tabs.update and windows.create refuse chrome:// URLs,
// and about:newtab too ("Illegal URL", measured on Firefox 160).
//   - Options pages link to chrome://extensions/shortcuts (Speechify's "open
//     shortcuts" command); Firefox has commands.openShortcutSettings() for it.
//   - tabs.update(id, { url: "chrome://newtab" }) shows the add-on's own page in
//     Chrome when it overrides the new tab page; the url was dropped, so the
//     tab stayed where it was.

function firefoxTabs(calls) {
  return {
    create: (props, ...rest) => { calls.push(["tabs.create", props]); return Promise.resolve({ id: 7, url: props.url }); },
    update: (...args) => { calls.push(["tabs.update", ...args.filter((a) => typeof a !== "function")]); return Promise.resolve({ id: 3 }); },
    query: (q) => { calls.push(["tabs.query", q]); return Promise.resolve([{ id: 42, url: "about:addons" }]); },
  };
}

function background(files, config = {}, { commands = true } = {}) {
  const browser = fakeBrowser();
  const calls = browser.calls;
  browser.tabs = firefoxTabs(calls);
  browser.windows = { create: (o) => { calls.push(["windows.create", o]); return Promise.resolve({ id: 9 }); } };
  if (commands) browser.commands = { openShortcutSettings: () => { calls.push(["commands.openShortcutSettings"]); return Promise.resolve(); } };
  const ctx = runInContext(buildShim(config, files), { browser });
  return { ctx, calls };
}

const SHORTCUTS = { "options.js": 'chrome.tabs.create({ url: "chrome://extensions/shortcuts" })' };

test("Chrome's shortcuts page opens Firefox's, and the call answers with that tab", async () => {
  const { ctx, calls } = background(SHORTCUTS);
  const tab = await vm.runInContext('chrome.tabs.create({ url: "chrome://extensions/shortcuts" })', ctx);
  assert.deepEqual(plain(tab), { id: 42, url: "about:addons" });
  assert.deepEqual(calls.filter((c) => c[0] !== "tabs.query"), [["commands.openShortcutSettings"]], "Firefox never sees the chrome:// URL");

  calls.length = 0;
  vm.runInContext('chrome.tabs.update(5, { url: "chrome://extensions/configureCommands" }, (t) => { globalThis.cbTab = t; })', ctx);
  await tick(5);
  assert.equal(ctx.cbTab.id, 42);
  assert.deepEqual(calls[0], ["commands.openShortcutSettings"]);
});

test("without a commands API the URL goes to Firefox as it is", async () => {
  const { ctx, calls } = background(SHORTCUTS, {}, { commands: false });
  await vm.runInContext('chrome.tabs.create({ url: "chrome://extensions/shortcuts" })', ctx);
  assert.deepEqual(plain(calls), [["tabs.create", { url: "chrome://extensions/shortcuts" }]]);
});

test("chrome://newtab in tabs.update shows the add-on's own new tab page when it has one", async () => {
  const files = { "bg.js": 'chrome.tabs.update(1, { url: "chrome://newtab/" })' };
  const own = background(files, { newTabPage: "/dashboard.html?x=1" });
  await vm.runInContext('chrome.tabs.update(1, { url: "chrome://newtab/" }); chrome.windows.create({ url: ["https://a.example/", "chrome://newtab"] }); chrome.tabs.create({ url: "chrome://newtab" })', own.ctx);
  assert.deepEqual(plain(own.calls), [
    ["tabs.update", 1, { url: EXT_ORIGIN + "/dashboard.html" }],
    ["windows.create", { url: ["https://a.example/", EXT_ORIGIN + "/dashboard.html"] }],
    ["tabs.create", {}],
  ]);

  // Without one, Firefox's own new tab page is what tabs.create and
  // windows.create open given no URL; tabs.update can't go there.
  const plainNewTab = background(files);
  await vm.runInContext('chrome.tabs.update(1, { url: "chrome://newtab/" }); chrome.windows.create({ url: ["https://a.example/", "chrome://newtab"] })', plainNewTab.ctx);
  assert.deepEqual(plain(plainNewTab.calls), [["tabs.update", 1, {}], ["windows.create", { url: ["https://a.example/"] }]]);
});

test("a bundle that names neither URL keeps Firefox's methods", () => {
  const browser = fakeBrowser();
  const tabs = firefoxTabs([]);
  const create = tabs.create;
  browser.tabs = tabs;
  runInContext(buildShim({ newTabPage: "tab.html" }, { "bg.js": "chrome.tabs.create({ url })" }), { browser });
  assert.equal(browser.tabs.create, create);
});
