import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  buildShim, fakeBrowser, fakeSidebarAction, makeEvent, makeLocalStorage, makeStorageArea, runInContext, plain, tick, EXT_ORIGIN,
} from "./shim-sandbox.js";

// Firefox has no chrome.sidePanel; the converted manifest declares a
// sidebar_action instead, and the shim drives it. sidebarAction.open() only
// works inside a user action, so the shim must reach it synchronously.

const MANIFEST = {
  manifest_version: 3, name: "T", version: "1",
  sidebar_action: { default_panel: "panel.html?mode=window" },
};

function background({ localStorage = makeLocalStorage(), config = { sidePanelPath: "panel.html" }, withSidebar = true } = {}) {
  const browser = fakeBrowser({ manifest: MANIFEST });
  const sidebar = withSidebar ? fakeSidebarAction(browser.calls) : null;
  if (sidebar) {
    browser.sidebarAction = sidebar;
    sidebar.setDefault(EXT_ORIGIN + "/panel.html?mode=window");
  }
  browser.action = { onClicked: makeEvent() };
  runInContext(buildShim(config), { browser, globals: { localStorage } });
  return { browser, sidebar, localStorage };
}

const names = (calls) => calls.map((c) => c[0]);

test("sidePanel.open() calls sidebarAction.open before returning", async () => {
  const { browser } = background();
  const p = browser.sidePanel.open({ windowId: 1 });
  assert.deepEqual(names(browser.calls), ["sidebarAction.open"], "a call after an await would lose the user action");
  assert.equal(await p, undefined);
});

test("openPanelOnActionClick toggles the sidebar on an action click, also after the background restarts", async () => {
  const localStorage = makeLocalStorage();
  const first = background({ localStorage });
  first.browser.action.onClicked.fire({ id: 1 });
  assert.ok(!names(first.browser.calls).includes("sidebarAction.toggle"), "behaviour is off by default");

  await first.browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  first.browser.action.onClicked.fire({ id: 1 });
  assert.ok(names(first.browser.calls).includes("sidebarAction.toggle"));

  // The event page was suspended and woke up for the click: nothing re-runs setPanelBehavior.
  const second = background({ localStorage });
  assert.equal(second.browser.action.onClicked.listeners.length, 1, "listener registered at startup");
  second.browser.action.onClicked.fire({ id: 1 });
  assert.deepEqual(names(second.browser.calls), ["sidebarAction.toggle"]);
  assert.deepEqual(plain(await second.browser.sidePanel.getPanelBehavior()), { openPanelOnActionClick: true });
});

test("setOptions maps paths onto sidebar panels and keeps the configured query on the default page", async () => {
  const { browser } = background();
  await browser.sidePanel.setOptions({ path: "panel.html" });
  await browser.sidePanel.setOptions({ tabId: 5, path: "/other.html" });
  const setPanel = browser.calls.filter((c) => c[0] === "sidebarAction.setPanel").map((c) => plain(c[1]));
  assert.deepEqual(setPanel, [
    { panel: EXT_ORIGIN + "/panel.html?mode=window" },
    { tabId: 5, panel: EXT_ORIGIN + "/other.html" },
  ]);
  assert.deepEqual(plain(await browser.sidePanel.getOptions({})), { enabled: true, path: "panel.html" });
});

test("a panel disabled for a tab refuses to open there", async () => {
  const { browser } = background();
  await browser.sidePanel.setOptions({ tabId: 3, enabled: false });
  await assert.rejects(browser.sidePanel.open({ tabId: 3 }), /No active side panel/);
  assert.ok(!names(browser.calls).includes("sidebarAction.open"));
  assert.deepEqual(plain(await browser.sidePanel.getOptions({ tabId: 3 })).enabled, false);
});

test("callback style works alongside promises", async () => {
  const { browser } = background();
  const got = await new Promise((resolve) => browser.sidePanel.getOptions({}, resolve));
  assert.equal(plain(got).path, "panel.html");
});

test("without a sidebar_action the panel opens as a popup window", async () => {
  const { browser } = background({ withSidebar: false, config: { sidePanelPath: "sp/index.html" } });
  await browser.sidePanel.open({ windowId: 1 });
  const create = browser.calls.find((c) => c[0] === "windows.create");
  assert.ok(create, JSON.stringify(browser.calls));
  assert.equal(create[1].url, EXT_ORIGIN + "/sp/index.html");
  assert.equal(create[1].type, "popup");
});

test("a panel path set at runtime carries the window-mode query, without overriding a key the path sets", async () => {
  const config = { sidePanelPath: "panel.html", panelQuery: "mode=window" };
  const { browser } = background({ config });
  // Claude in Chrome sets its panel per tab, with a query of its own.
  await browser.sidePanel.setOptions({ tabId: 5, path: "panel.html?tabId=5", enabled: true });
  await browser.sidePanel.setOptions({ tabId: 6, path: "panel.html?mode=compact&tabId=6" });
  await browser.sidePanel.setOptions({ tabId: 7, path: "other.html?tabId=7" });
  const setPanel = browser.calls.filter((c) => c[0] === "sidebarAction.setPanel").map((c) => plain(c[1]));
  assert.deepEqual(setPanel, [
    { tabId: 5, panel: EXT_ORIGIN + "/panel.html?tabId=5&mode=window" },
    { tabId: 6, panel: EXT_ORIGIN + "/panel.html?mode=compact&tabId=6" },
    { tabId: 7, panel: EXT_ORIGIN + "/other.html?tabId=7" },
  ]);
  assert.equal(plain(await browser.sidePanel.getOptions({ tabId: 5 })).path, "panel.html?tabId=5", "the extension reads back what it set");

  const popup = background({ config, withSidebar: false });
  await popup.browser.sidePanel.setOptions({ tabId: 5, path: "panel.html?tabId=5" });
  await popup.browser.sidePanel.open({ tabId: 5 });
  const create = popup.browser.calls.find((c) => c[0] === "windows.create");
  assert.equal(create[1].url, EXT_ORIGIN + "/panel.html?tabId=5&mode=window");
});

test("members Firefox already provides are never replaced", () => {
  const browser = fakeBrowser({ manifest: MANIFEST });
  const nativeSidePanel = { open() {} };
  const nativeOffscreen = { createDocument() {} };
  const nativeGetAuthToken = () => {};
  const identity = { getRedirectURL: () => "https://x.extensions.allizom.org/", launchWebAuthFlow() {}, getAuthToken: nativeGetAuthToken };
  Object.assign(browser, { sidePanel: nativeSidePanel, offscreen: nativeOffscreen, identity });
  browser.sidebarAction = fakeSidebarAction(browser.calls);
  const before = new Map(Object.entries(browser).concat(Object.entries(browser.runtime).map(([k, v]) => ["runtime." + k, v])));
  const lastErrorBefore = Object.getOwnPropertyDescriptor(browser.runtime, "lastError");
  runInContext(buildShim({ sidePanelPath: "panel.html" }), {
    browser,
    globals: { document: { body: { appendChild() {} }, createElement: () => ({ style: {}, addEventListener() {}, setAttribute() {} }) } },
  });
  assert.equal(browser.sidePanel, nativeSidePanel);
  assert.equal(browser.offscreen, nativeOffscreen);
  assert.equal(browser.identity.getAuthToken, nativeGetAuthToken);
  for (const [k, v] of before) {
    const now = k.startsWith("runtime.") ? browser.runtime[k.slice(8)] : browser[k];
    assert.equal(now, v, k + " was replaced");
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(browser.runtime, "lastError"), lastErrorBefore);
});

test("content scripts get no sidePanel", () => {
  const browser = fakeBrowser({ manifest: MANIFEST });
  runInContext(buildShim({ sidePanelPath: "panel.html" }), { browser, href: "https://example.com/" });
  assert.equal(browser.sidePanel, undefined);
});

// An add-on whose Chrome manifest declares no side panel, like Claude in
// Chrome: its toolbar button gives the tab a panel of its own, whose URL
// carries the tab, and Chrome shows the panel on that tab only.
const TAB_PANEL_MANIFEST = {
  manifest_version: 3, name: "T", version: "1",
  sidebar_action: { default_panel: "panel.html" },
};
const TAB_PANEL_CONFIG = { sidePanelPath: "panel.html", noDefaultPanel: true };
const OPEN_FOR_TAB = "__sidePanelShim:message";

function tabPanelBackground({ session, tabs = {}, config = TAB_PANEL_CONFIG, sidebar: sidebarOverrides = {} } = {}) {
  const browser = fakeBrowser({ manifest: TAB_PANEL_MANIFEST });
  browser.sidebarAction = { ...fakeSidebarAction(browser.calls), ...sidebarOverrides };
  browser.action = { onClicked: makeEvent() };
  if (session) browser.storage.session = session;
  browser.tabs.get = (id) => (tabs[id] ? Promise.resolve(tabs[id]) : Promise.reject(new Error(`Invalid tab ID: ${id}`)));
  runInContext(buildShim(config), { browser, globals: { localStorage: makeLocalStorage() } });
  return browser;
}

// The add-on's sidebar page, as Firefox shows it in window 4 with `selected`
// as that window's tab. Returns a function that fires DOMContentLoaded.
function sidebarPage(href, { session, selected = { id: 7, active: true, windowId: 4 }, config = TAB_PANEL_CONFIG } = {}) {
  const browser = fakeBrowser({ manifest: TAB_PANEL_MANIFEST });
  browser.sidebarAction = fakeSidebarAction(browser.calls);
  if (session) browser.storage.session = session;
  browser.windows.getCurrent = () => Promise.resolve({ id: 4 });
  browser.tabs.query = (q) => Promise.resolve(q.active && q.windowId === 4 ? [selected] : []);
  const loaded = [];
  const document = { addEventListener: (type, fn) => { if (type === "DOMContentLoaded") loaded.push(fn); } };
  const page = runInContext(buildShim(config), {
    browser, href, globals: { localStorage: makeLocalStorage(), document, addEventListener() {} },
  });
  // Inside the page, `window` is the context's global, not the object it was made from.
  const win = vm.runInContext("globalThis", page);
  browser.extension.getViews = (q) => (q && q.type === "sidebar" ? [win] : []);
  return { browser, load: () => loaded.forEach((fn) => fn()) };
}

const settled = () => tick(20);

test("a tab's panel stays in the sidebar for the window's other tabs", async () => {
  const session = makeStorageArea();
  const bg = tabPanelBackground({ session });
  await bg.sidePanel.setOptions({ tabId: 7, path: "panel.html?tabId=7", enabled: true });

  const { browser, load } = sidebarPage(EXT_ORIGIN + "/panel.html?tabId=7", { session });
  load();
  await settled();
  const setPanel = browser.calls.filter((c) => c[0] === "sidebarAction.setPanel").map((c) => plain(c[1]));
  assert.deepEqual(setPanel, [{ windowId: 4, panel: EXT_ORIGIN + "/panel.html?tabId=7" }],
    "without a window panel Firefox swaps in sidebar_action's page, with no tab, on the next tab switch");
  assert.ok(!names(browser.calls).includes("runtime.sendMessage"));
});

test("a sidebar that comes up on a tab without a panel asks the background to give it one", async () => {
  const session = makeStorageArea();
  // Opened from Firefox's own UI: sidebar_action's page.
  const fresh = sidebarPage(EXT_ORIGIN + "/panel.html", { session });
  fresh.load();
  await settled();
  const asked = fresh.browser.calls.filter((c) => c[0] === "runtime.sendMessage").map((c) => plain(c[1]));
  assert.deepEqual(asked, [{ [OPEN_FOR_TAB]: "openForTab", windowId: 4, tabId: 7 }]);
  assert.ok(!names(fresh.browser.calls).includes("sidebarAction.setPanel"));

  // Reopened on tab 7 after showing tab 3's panel: the window still lists that
  // page, but tab 7 has none of its own.
  await session.set({ "__sidePanelShim:tab:3": EXT_ORIGIN + "/panel.html?tabId=3" });
  const stale = sidebarPage(EXT_ORIGIN + "/panel.html?tabId=3", { session });
  stale.load();
  await settled();
  assert.deepEqual(stale.browser.calls.filter((c) => c[0] === "runtime.sendMessage").map((c) => plain(c[1]).tabId), [7]);
  assert.ok(!names(stale.browser.calls).includes("sidebarAction.setPanel"), "tab 3's page isn't kept for tab 7");
});

test("the background answers with what a click on the toolbar button does, unseen by the add-on's own listeners", async () => {
  const tabs = { 7: { id: 7, active: true, windowId: 4 }, 8: { id: 8, active: false, windowId: 4 } };
  const bg = tabPanelBackground({ session: makeStorageArea(), tabs });
  const clicks = [];
  const seen = [];
  bg.action.onClicked.addListener((tab) => clicks.push(tab.id));
  bg.runtime.onMessage.addListener((m) => { seen.push(m); });
  // Firefox hands the sender the first answer; the add-on's own listeners give none.
  const send = async (message) => (await Promise.all(bg.runtime.onMessage.fire(message, { id: bg.runtime.id }, () => {}))).filter((r) => r !== undefined);

  assert.deepEqual(await send({ [OPEN_FOR_TAB]: "openForTab", windowId: 4, tabId: 7 }), [true]);
  assert.deepEqual(clicks, [7]);
  await send({ [OPEN_FOR_TAB]: "openForTab", windowId: 4, tabId: 8 });
  assert.deepEqual(clicks, [7], "a tab the user has left behind isn't clicked for");
  assert.deepEqual(seen, []);

  await bg.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await send({ [OPEN_FOR_TAB]: "openForTab", windowId: 4, tabId: 7 });
  assert.deepEqual(clicks, [7], "with openPanelOnActionClick Chrome doesn't tell the add-on about clicks");
});

test("an add-on with a panel for all tabs keeps Firefox's behaviour", async () => {
  const config = { sidePanelPath: "panel.html" };
  const { browser, load } = sidebarPage(EXT_ORIGIN + "/panel.html", { session: makeStorageArea(), config });
  load();
  await settled();
  assert.ok(!names(browser.calls).includes("runtime.sendMessage"));
  assert.ok(!names(browser.calls).includes("sidebarAction.setPanel"));

  const bg = tabPanelBackground({ session: makeStorageArea(), config });
  const listener = () => {};
  bg.action.onClicked.addListener(listener);
  assert.deepEqual(bg.action.onClicked.listeners, [listener], "its toolbar listeners aren't wrapped");
});

test("open() succeeds outside a user action when the sidebar is already open, as in Chrome", async () => {
  const refuse = () => Promise.reject(new Error("sidebarAction.open may only be called from a user input handler"));
  const tabs = { 7: { id: 7, active: true, windowId: 4 } };
  const open = tabPanelBackground({ tabs, sidebar: { open: refuse, isOpen: (d) => Promise.resolve(d.windowId === 4) } });
  assert.equal(await open.sidePanel.open({ tabId: 7 }), undefined);
  assert.equal(await open.sidePanel.open({ windowId: 4 }), undefined);

  const closed = tabPanelBackground({ tabs, sidebar: { open: refuse, isOpen: () => Promise.resolve(false) } });
  await assert.rejects(closed.sidePanel.open({ tabId: 7 }), /user input handler/);
});
