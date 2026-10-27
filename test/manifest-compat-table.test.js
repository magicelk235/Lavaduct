import { test } from "node:test";
import assert from "node:assert/strict";
import { UNSUPPORTED_APIS, UNSUPPORTED_PERMISSIONS } from "../dist/manifest/compat-data.js";

test("APIs the shim covers are reported as shimmed, not as failures", () => {
  for (const key of ["chrome.offscreen", "chrome.sidePanel", "chrome.identity.getAuthToken", "chrome.identity.getProfileUserInfo"]) {
    assert.equal(UNSUPPORTED_APIS[key]?.shimmed, true, key);
    assert.equal(UNSUPPORTED_APIS[key].severity, "info", key);
  }
});

test("asking getContexts for offscreen documents is flagged, since the shim can't cover it", () => {
  assert.equal(UNSUPPORTED_APIS.OFFSCREEN_DOCUMENT?.severity, "warning");
  assert.ok(!UNSUPPORTED_APIS.OFFSCREEN_DOCUMENT.shimmed);
});

test("an API Firefox lacks is a warning; one Firefox added later carries its release", () => {
  assert.equal(UNSUPPORTED_APIS["chrome.debugger"]?.severity, "warning");
  assert.equal(UNSUPPORTED_APIS["chrome.tabGroups"]?.since, "139");
  assert.equal("chrome.tabs.query" in UNSUPPORTED_APIS, false, "a long-standing API isn't listed");
});

test("a key that prefixes a supported API only matches the whole name", () => {
  // Without the boundary, management.uninstallSelf (fine in Firefox) would be flagged.
  assert.ok("chrome.management.uninstall\\b" in UNSUPPORTED_APIS);
  assert.equal("chrome.management.uninstall" in UNSUPPORTED_APIS, false);
});

test("members Firefox defines are never reported as throwing", () => {
  assert.equal("chrome.tabs.onReplaced" in UNSUPPORTED_APIS, false);
  assert.doesNotMatch(UNSUPPORTED_APIS["chrome.notifications.onButtonClicked"].message, /throws/);
});

test("permissions Firefox lacks are stripped; ones it has are kept", () => {
  for (const perm of ["debugger", "offscreen", "sidePanel", "background"]) assert.ok(perm in UNSUPPORTED_PERMISSIONS, perm);
  for (const perm of ["tabs", "userScripts", "webRequestBlocking", "contextMenus", "publicSuffix"]) assert.equal(perm in UNSUPPORTED_PERMISSIONS, false, perm);
});
