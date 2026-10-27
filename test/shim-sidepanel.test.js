import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildShim, fakeBrowser, fakeSidebarAction, makeEvent, makeLocalStorage, runInContext, plain, EXT_ORIGIN,
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
