// Chrome shows the extension's own icons for an action that declares no
// default_icon. Firefox doesn't: a page_action or sidebar_action without one gets
// the generic puzzle piece (extensionGeneric.svg), even when the add-on has icons.
// The sidebar made from side_panel copied the icons before the placeholder set
// existed, so an extension without icons got an icon-less sidebar as well. A
// sidebar_action the author wrote for Firefox is left as it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { synthesizePlaceholderIcons } from "../dist/input/icons.js";
import { firefox, loadAddon } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function stage(t) {
  const dir = mkdtempSync(join(tmpdir(), "icons-actions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a page_action without default_icon gets the manifest's icons", () => {
  const out = transformManifest(
    {
      manifest_version: 2,
      name: "Icons",
      version: "1",
      icons: { 48: "i48.png", 128: "i128.png" },
      page_action: { default_title: "Page" },
    },
    [],
    options,
  );
  assert.deepEqual(out.page_action.default_icon, { 48: "i48.png", 128: "i128.png" });
});

test("an action's own default_icon is kept", () => {
  const out = transformManifest(
    { manifest_version: 2, name: "Own", version: "1", icons: { 48: "i48.png" }, page_action: { default_icon: "page.png" } },
    [],
    options,
  );
  assert.equal(out.page_action.default_icon, "page.png");
});

test("placeholder icons reach the sidebar made from side_panel and the page action", (t) => {
  const dir = stage(t);
  const out = transformManifest(
    { manifest_version: 3, name: "Bare", version: "1", side_panel: { default_path: "panel.html" }, page_action: { default_title: "Page" } },
    [],
    options,
  );
  synthesizePlaceholderIcons(dir, out, "Bare");
  assert.deepEqual(out.sidebar_action.default_icon, out.icons);
  assert.deepEqual(out.page_action.default_icon, out.icons);
});

test("Firefox shows the add-on's icon on the sidebar and the page action", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  const dir = stage(t);
  const out = transformManifest(
    {
      manifest_version: 3,
      name: "Bare",
      version: "1",
      side_panel: { default_path: "panel.html" },
      page_action: { default_title: "Page", show_matches: ["<all_urls>"] },
    },
    [],
    options,
  );
  synthesizePlaceholderIcons(dir, out, "Bare");
  delete out.sidebar_action.open_at_install;
  const files = { "panel.html": "<p>panel</p>" };
  for (const name of Object.values(out.icons)) files[name] = readFileSync(join(dir, name));
  const seen = await loadAddon(out, files, async ({ chrome, id }) =>
    JSON.parse(
      await chrome(`(async () => {
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        let sidebar, page;
        for (let i = 0; i < 100 && !(sidebar && page); i++) {
          sidebar = [...win.SidebarController.sidebars].find(([key]) => key.includes("sidebar-action"))?.[1]?.iconUrl;
          page = win.PageActions.actions.find((a) => a.extensionID === ${JSON.stringify(ID)})?.getIconURL(win);
          await new Promise((r) => setTimeout(r, 100));
        }
        return JSON.stringify({ sidebar, page: page && Object.values(page) });
      })()`),
    ),
  );
  assert.ok(seen.sidebar && !seen.sidebar.includes("extensionGeneric"), `sidebar icon: ${seen.sidebar}`);
  assert.ok(seen.page?.length && seen.page.every((u) => !u.includes("extensionGeneric")), `page action icon: ${seen.page}`);
});
