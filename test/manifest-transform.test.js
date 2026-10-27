import { test } from "node:test";
import assert from "node:assert/strict";
import { transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";

const options = (over = {}) => ({
  addonId: ID,
  minFirefoxVersion: DEFAULT_MIN_FIREFOX,
  platforms: "desktop",
  version: "1.2.3",
  ...over,
});

const sidePanelManifest = () => ({
  manifest_version: 3,
  name: "Panel Helper",
  version: "1.2.3",
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA",
  update_url: "https://clients2.google.com/service/update2/crx",
  minimum_chrome_version: "114",
  incognito: "split",
  icons: { 16: "icon16.png", 128: "icon128.png" },
  action: { default_title: "Open helper" },
  side_panel: { default_path: "panel/index.html" },
  permissions: ["sidePanel", "storage"],
  background: { service_worker: "sw.js" },
  oauth2: { client_id: "123.apps.googleusercontent.com", scopes: ["email"] },
});

test("an MV3 side-panel extension gets a gecko block and a sidebar that stays closed at install", () => {
  const out = transformManifest(sidePanelManifest(), ["sidePanel"], options());

  assert.deepEqual(out.browser_specific_settings, {
    gecko: { id: ID, strict_min_version: DEFAULT_MIN_FIREFOX },
  });
  assert.deepEqual(out.sidebar_action, {
    default_panel: "panel/index.html",
    default_title: "Open helper",
    default_icon: { 16: "icon16.png", 128: "icon128.png" },
    open_at_install: false,
  });
  for (const key of ["side_panel", "key", "update_url", "minimum_chrome_version", "incognito"]) {
    assert.equal(key in out, false, `${key} should be gone`);
  }
  assert.deepEqual(out.permissions, ["storage"]);
  assert.equal(out.version, "1.2.3");
  assert.deepEqual(out.background, { service_worker: "sw.js" }, "the background is rewritten elsewhere");
  // The identity shim reads the client from the packaged manifest.json.
  assert.deepEqual(out.oauth2, { client_id: "123.apps.googleusercontent.com", scopes: ["email"] });
});

test("the transform leaves its input untouched", () => {
  const input = sidePanelManifest();
  const snapshot = JSON.stringify(input);
  transformManifest(input, ["sidePanel"], options({ dataCollection: ["none"], contentScriptPrepend: ["shim.js"] }));
  assert.equal(JSON.stringify(input), snapshot);
});

test("the panel query lands before any fragment of the sidebar page", () => {
  const m = sidePanelManifest();
  m.side_panel.default_path = "panel.html#home";
  assert.equal(
    transformManifest(m, [], options({ sidebarPanelQuery: "mode=sidebar" })).sidebar_action.default_panel,
    "panel.html?mode=sidebar#home",
  );
  m.side_panel.default_path = "panel.html?tab=1";
  assert.equal(
    transformManifest(m, [], options({ sidebarPanelQuery: "mode=sidebar" })).sidebar_action.default_panel,
    "panel.html?tab=1&mode=sidebar",
  );
  assert.equal(transformManifest(m, [], options({ sidebarPanelQuery: "" })).sidebar_action.default_panel, "panel.html?tab=1");
});

test("the sidebar title falls back to the extension name", () => {
  const m = sidePanelManifest();
  delete m.action;
  assert.equal(transformManifest(m, [], options()).sidebar_action.default_title, "Panel Helper");
});

test("a side_panel without a page gives no sidebar_action, which Firefox would reject", () => {
  const m = sidePanelManifest();
  m.side_panel = {};
  const out = transformManifest(m, [], options());
  assert.equal("sidebar_action" in out, false);
  assert.equal("side_panel" in out, false);
});

test("an existing sidebar_action is kept as the author wrote it", () => {
  const m = sidePanelManifest();
  m.sidebar_action = { default_panel: "firefox-sidebar.html" };
  assert.deepEqual(transformManifest(m, [], options()).sidebar_action, { default_panel: "firefox-sidebar.html" });
});

test("platforms decide between gecko and gecko_android", () => {
  const m = { manifest_version: 3, name: "X", version: "1", browser_specific_settings: { gecko_android: { strict_min_version: "120.0" } } };

  const desktop = transformManifest(m, [], options()).browser_specific_settings;
  assert.deepEqual(desktop, { gecko: { id: ID, strict_min_version: DEFAULT_MIN_FIREFOX } });

  const all = transformManifest(m, [], options({ platforms: "all" })).browser_specific_settings;
  assert.deepEqual(all, { gecko: { id: ID, strict_min_version: DEFAULT_MIN_FIREFOX }, gecko_android: {} });

  const android = transformManifest(m, [], options({ platforms: "android" })).browser_specific_settings;
  assert.deepEqual(android, { gecko: { id: ID }, gecko_android: {} });
});

test("an author's own gecko id is replaced, other gecko settings survive", () => {
  const m = {
    manifest_version: 3,
    name: "X",
    version: "1",
    browser_specific_settings: { gecko: { id: "theirs@example.com", strict_min_version: "109.0", strict_max_version: "200.*" } },
  };
  assert.deepEqual(transformManifest(m, [], options()).browser_specific_settings.gecko, {
    id: ID,
    strict_min_version: DEFAULT_MIN_FIREFOX,
    strict_max_version: "200.*",
  });
});

test("data_collection_permissions is written only when asked for", () => {
  const m = { manifest_version: 3, name: "X", version: "1" };
  assert.equal("data_collection_permissions" in transformManifest(m, [], options()).browser_specific_settings.gecko, false);
  assert.deepEqual(
    transformManifest(m, [], options({ dataCollection: ["none"] })).browser_specific_settings.gecko.data_collection_permissions,
    { required: ["none"] },
  );
});

test("the shim goes first in isolated-world content scripts only", () => {
  const m = {
    manifest_version: 3,
    name: "X",
    version: "1",
    content_scripts: [
      { matches: ["<all_urls>"], js: ["content.js"] },
      { matches: ["<all_urls>"], js: ["page.js"], world: "MAIN" },
      { matches: ["<all_urls>"], css: ["style.css"] },
      { matches: ["<all_urls>"], js: ["shim.js", "other.js"], world: "ISOLATED" },
    ],
  };
  const out = transformManifest(m, [], options({ contentScriptPrepend: ["shim.js"] }));
  assert.deepEqual(out.content_scripts[0].js, ["shim.js", "content.js"]);
  assert.deepEqual(out.content_scripts[1].js, ["page.js"]);
  assert.equal("js" in out.content_scripts[2], false);
  assert.deepEqual(out.content_scripts[3].js, ["shim.js", "other.js"]);
});

test("use_dynamic_url is dropped from web_accessible_resources", () => {
  const m = {
    manifest_version: 3,
    name: "X",
    version: "1",
    web_accessible_resources: [{ resources: ["panel.css"], matches: ["<all_urls>"], use_dynamic_url: true }],
  };
  assert.deepEqual(transformManifest(m, [], options()).web_accessible_resources, [
    { resources: ["panel.css"], matches: ["<all_urls>"] },
  ]);
});

test("permissions land where Firefox accepts them", () => {
  const m = {
    manifest_version: 3,
    name: "X",
    version: "1",
    permissions: ["tabs", "debugger", "userScripts", "chrome://favicon/", "https://example.com/*"],
    optional_permissions: ["contextMenus", "bookmarks", "debugger"],
    host_permissions: ["https://*.example.com/*", "chrome://*/*"],
  };
  const out = transformManifest(m, ["debugger"], options());
  // contextMenus is granted at install in Firefox and ignored as optional; userScripts
  // is the reverse. Patterns with schemes Firefox can't grant go away.
  assert.deepEqual(out.permissions, ["tabs", "https://example.com/*", "contextMenus"]);
  assert.deepEqual(out.optional_permissions, ["bookmarks", "userScripts"]);
  assert.deepEqual(out.host_permissions, ["https://*.example.com/*"]);
});

test("an optional list emptied by the move is removed", () => {
  const m = { manifest_version: 3, name: "X", version: "1", permissions: ["storage"], optional_permissions: ["storage", "alarms"] };
  const out = transformManifest(m, [], options());
  assert.deepEqual(out.permissions, ["storage", "alarms"]);
  assert.equal("optional_permissions" in out, false);
});
