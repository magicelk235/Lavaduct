import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, fakeSidebarAction, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// Chrome defines chrome.sidePanel only for an add-on with the sidePanel
// permission, and shared code feature-tests it:
//   if (chrome.sidePanel) chrome.sidePanel.open(...) else chrome.windows.create(...)
// Desktop Firefox always has windows, so every converted add-on got the
// emulation and took the panel branch, whose open() then failed.

const IS_THERE = "typeof chrome.sidePanel";

function popup(config) {
  const browser = fakeBrowser();
  browser.sidebarAction = fakeSidebarAction(browser.calls);
  return runInContext(buildShim(config), { browser, href: EXT_ORIGIN + "/popup.html" });
}

test("an add-on that never asked for a side panel has no chrome.sidePanel", () => {
  assert.equal(vm.runInContext(IS_THERE, popup({ declaredPermissions: ["tabs", "storage"] })), "undefined");
  assert.equal(vm.runInContext(IS_THERE, popup({})), "undefined");
});

test("the sidePanel permission, a side_panel page or a page found in the code brings it", () => {
  assert.equal(vm.runInContext(IS_THERE, popup({ declaredPermissions: ["sidePanel"] })), "object");
  assert.equal(vm.runInContext(IS_THERE, popup({ sidePanelPath: "panel.html" })), "object");
  assert.equal(vm.runInContext(IS_THERE, popup({ sidePanelPath: "sidepanel.html", noDefaultPanel: true })), "object");
});
