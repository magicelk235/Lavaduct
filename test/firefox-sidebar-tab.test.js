// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-sidebar-tab-live-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// Like Claude in Chrome: no side_panel in the manifest; the toolbar button gives
// the tab a panel of its own, and the panel's URL carries the tab.
const SW = `chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.setOptions({ tabId: tab.id, path: "panel.html?tabId=" + tab.id, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id });
});`;

test(
  "the sidebar's page keeps the tab its panel belongs to, wherever Firefox opens it",
  { skip: firefox ? false : "no Firefox install found", timeout: 180_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${req.url}</title>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const site = `http://127.0.0.1:${server.address().port}`;

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Tab Panel Probe", version: "1.0",
      permissions: ["sidePanel", "storage", "tabs"],
      action: { default_title: "Open the panel" },
      background: { service_worker: "sw.js" },
    }));
    writeFileSync(join(ext, "sw.js"), SW);
    writeFileSync(join(ext, "panel.html"), `<!doctype html><meta charset="utf-8"><title>Panel</title><body>panel</body>`);
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    assert.ok(result.success, "the extension converts");

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const ff = await startPrivilegedFirefox(firefox, profile);
    // Closed in a finally rather than an after hook: hooks run in the order they
    // were added, so the scratch folder would go first, which Windows refuses
    // while Firefox has the profile open, and the hooks after it never run.
    try {
      const id = await ff.installAddon(result.stagedPath);
      const widget = JSON.stringify(id.toLowerCase().replace(/[^a-z0-9_-]/g, "_") + "-sidebar-action");
      // Two tabs, by their add-on tab IDs.
      const tabs = JSON.parse(await ff.chrome(`(async () => {
        const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        const principal = Services.scriptSecurityManager.getSystemPrincipal();
        const one = win.gBrowser.addTab(${JSON.stringify(`${site}/one`)}, { triggeringPrincipal: principal });
        const two = win.gBrowser.addTab(${JSON.stringify(`${site}/two`)}, { triggeringPrincipal: principal });
        const ids = ExtensionParent.apiManager.global.tabTracker;
        return JSON.stringify({ one: ids.getId(one), two: ids.getId(two) });
      })()`));
      // Selecting a tab does nothing while the new profile's onboarding dialog
      // is up, which can come up late; it goes first.
      const select = async (which) => {
        for (let i = 0; i < 50; i++) {
          const selected = await ff.chrome(`(() => {
            const win = Services.wm.getMostRecentWindow("navigator:browser");
            if (win.gDialogBox?.isOpen) win.gDialogBox.dialog?.close();
            const tab = win.gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec.endsWith("/${which}"));
            if (tab) win.gBrowser.selectedTab = tab;
            return win.gBrowser.selectedTab === tab;
          })()`);
          if (selected) return;
          await sleep(100);
        }
        assert.fail(`couldn't select the tab at /${which}`);
      };
      await select("one");
      // The page in the sidebar, and which document it is.
      const sidebar = async () => JSON.parse(await ff.chrome(`(() => {
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        const panel = win.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
        const global = panel?.browsingContext?.currentWindowGlobal;
        return JSON.stringify({ open: win.SidebarController.isOpen, url: panel ? panel.currentURI.spec.replace(/^moz-extension:\\/\\/[^/]+/, "") : "", doc: global ? global.innerWindowId : 0 });
      })()`));
      const settle = async (url) => {
        let now = await sidebar();
        for (let i = 0; i < 100 && now.url !== url; i++) {
          await sleep(100);
          now = await sidebar();
        }
        return now;
      };
      const showFromFirefoxUi = () => ff.chrome(`Services.wm.getMostRecentWindow("navigator:browser").SidebarController.show(${widget})`);

      // Opened from Firefox's sidebar menu, where Chrome has only the toolbar button.
      await showFromFirefoxUi();
      const opened = await settle(`/panel.html?tabId=${tabs.one}`);
      assert.equal(opened.url, `/panel.html?tabId=${tabs.one}`, "the panel opened from Firefox's UI belongs to the selected tab");
      // The page pins itself for the whole window once it has looked up its tab's
      // record; a tab switch before that still gets Firefox's default page. On a
      // loaded CI runner the switch below came first.
      for (let i = 0; i < 100; i++) {
        const pinned = await ff.chrome(`(() => {
          const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
          const action = ExtensionParent.apiManager.global.sidebarAction.for(WebExtensionPolicy.getByID(${JSON.stringify(id)}).extension);
          return action.getProperty(Services.wm.getMostRecentWindow("navigator:browser"), "panel").replace(/^moz-extension:\\/\\/[^/]+/, "");
        })()`);
        if (pinned === opened.url) break;
        await sleep(100);
      }

      await select("two");
      await sleep(1500);
      const switched = await sidebar();
      assert.equal(switched.url, opened.url, "a tab switch doesn't swap in a page without a tab");
      assert.equal(switched.doc, opened.doc, "the panel isn't reloaded on a tab switch");

      await ff.chrome(`Services.wm.getMostRecentWindow("navigator:browser").SidebarController.hide()`);
      await showFromFirefoxUi();
      const reopened = await settle(`/panel.html?tabId=${tabs.two}`);
      assert.equal(reopened.url, `/panel.html?tabId=${tabs.two}`, "reopened on another tab, the panel belongs to that tab");
    } finally {
      await ff.close();
    }
  },
);
