// Chrome reserves command names starting with "_": it binds _execute_action,
// _execute_browser_action and _execute_page_action only when the manifest has the
// matching action key, and ignores every other one. MetaMask's MV3 manifest binds
// Alt+Shift+M to both _execute_browser_action and _execute_action. Firefox only
// reserves _execute_action in MV3, so _execute_browser_action becomes a plain
// command bound to the same keys, and pressing them fired commands.onCommand
// instead of opening the popup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";
import { firefox, loadAddon } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const key = { suggested_key: { default: "Alt+Shift+M" } };
const metamask = () => ({
  manifest_version: 3,
  name: "Wallet",
  version: "1.0",
  action: { default_popup: "popup.html" },
  background: { scripts: ["bg.js"] },
  commands: { _execute_browser_action: key, _execute_action: key },
});
const names = (m) => Object.keys(transformManifest(m, [], options).commands ?? {});

test("an MV3 manifest keeps _execute_action and loses the MV2 name", () => {
  assert.deepEqual(names(metamask()), ["_execute_action"]);
});

test("each action command stays only beside its action key, as Chrome binds it", () => {
  const mv2 = { manifest_version: 2, name: "Old", version: "1.0", browser_action: {}, commands: { _execute_action: key, _execute_browser_action: key, _execute_page_action: key } };
  assert.deepEqual(names(mv2), ["_execute_browser_action"]);
  assert.deepEqual(names({ ...mv2, page_action: {} }), ["_execute_browser_action", "_execute_page_action"]);
  assert.deepEqual(names({ manifest_version: 3, name: "No action", version: "1.0", commands: { _execute_action: key, run: key } }), ["run"]);
});

test("other reserved names go, Firefox's sidebar command and ordinary commands stay", () => {
  const m = { ...metamask(), commands: { _custom: key, _execute_sidebar_action: key, "toggle-it": key } };
  assert.deepEqual(names(m), ["_execute_sidebar_action", "toggle-it"]);
});

test("the analyzer and the report name the removed commands", () => {
  const { issues } = analyzeManifest(metamask(), { minFirefox: DEFAULT_MIN_FIREFOX });
  const [issue] = issues.filter((i) => i.message.includes("_execute_browser_action"));
  assert.equal(issue?.autoFixed, true);
  assert.equal(analyzeManifest({ ...metamask(), commands: { _execute_action: key } }, { minFirefox: DEFAULT_MIN_FIREFOX }).issues.filter((i) => i.message.includes("reserved")).length, 0);
  const before = metamask();
  const changes = summarizeManifestChanges(before, transformManifest(before, [], options));
  assert.ok(changes.some((c) => c.includes("`_execute_browser_action`")), changes.join("\n"));
});

// Presses Alt+Shift+M in the browser window and reports whether the action's popup
// opened and which commands.onCommand events fired.
async function pressShortcut(manifest) {
  const files = {
    "popup.html": "<!doctype html><p>popup</p>",
    "bg.js": `browser.commands.onCommand.addListener((name) => browser.storage.local.set({ ["fired:" + name]: true }));`,
  };
  manifest.permissions = ["storage"];
  return loadAddon(manifest, files, async ({ chrome, id }) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return JSON.parse(
      await chrome(`(async () => {
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
        tip.beginInputTransactionForTests(win);
        const key = (k, code, keyCode) => new win.KeyboardEvent("", { key: k, code, keyCode });
        const keys = [key("Alt", "AltLeft", win.KeyboardEvent.DOM_VK_ALT), key("Shift", "ShiftLeft", win.KeyboardEvent.DOM_VK_SHIFT), key("M", "KeyM", win.KeyboardEvent.DOM_VK_M)];
        for (const k of keys) tip.keydown(k);
        for (const k of keys.reverse()) tip.keyup(k);
        let popup = false;
        for (let i = 0; i < 50 && !popup; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          popup = [...win.document.querySelectorAll("browser")].some((b) => b.currentURI?.spec.endsWith("/popup.html"));
        }
        const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
        const policy = WebExtensionPolicy.getByID(${JSON.stringify(id)});
        const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(policy.extension));
        const fired = Object.keys(await db.get(null)).filter((k) => k.startsWith("fired:")).map((k) => k.slice(6));
        return JSON.stringify({ popup, fired });
      })()`),
    );
  });
}

test("the shortcut opens the popup in Firefox after the conversion, and didn't before", { skip: firefox ? false : "no Firefox install found", timeout: 180_000 }, async () => {
  const gecko = { browser_specific_settings: { gecko: { id: ID } } };
  assert.deepEqual(await pressShortcut({ ...metamask(), ...gecko }), { popup: false, fired: ["_execute_browser_action"] }, "Firefox now treats the MV2 name as the action; the removal may be unnecessary");
  assert.deepEqual(await pressShortcut(transformManifest(metamask(), [], options)), { popup: true, fired: [] });
});
