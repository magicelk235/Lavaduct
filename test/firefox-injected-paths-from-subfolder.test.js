// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { buildShim } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// Chrome resolves the files an add-on injects from its root; Firefox resolves them
// against the calling page. From an extension page in html/, Firefox 160 ran
// html/inject.js for files: ["inject.js"], failed insertCSS("s.css") with "An
// unexpected error occurred" and registered "html/reg.js", which never loaded. The
// shim put first in each injection failed the same way, so Loom's
// executeScript from html/videoPreview.html failed with "Unable to load script:
// …/html/lavaduct-compat-shim.js". The add-on here has only root copies of its files.

const SITE_HTML = "<!doctype html><title>site</title><body>site</body>";

function addon(mv, site) {
  const run = mv === 3 ? `
    out.executeScript = (await api.scripting.executeScript({ target, files: ["inject.js"] }))[0].result;
    await api.scripting.insertCSS({ target, files: ["s.css"] });
    out.insertCSS = await outline();
    await api.scripting.removeCSS({ target, files: ["s.css"] });
    out.removeCSS = await outline();
    await api.scripting.registerContentScripts([{ id: "r", matches: ["http://127.0.0.1/*"], js: ["reg.js"], runAt: "document_end" }]);
    out.registered = (await api.scripting.getRegisteredContentScripts()).map((s) => s.js);
    await reload();
    out.registeredRan = await marker();` : `
    out.executeScript = (await api.tabs.executeScript(tab.id, { file: "inject.js" }))[0];
    await api.tabs.insertCSS(tab.id, { file: "s.css" });
    out.insertCSS = await outline();
    await api.tabs.removeCSS(tab.id, { file: "s.css" });
    out.removeCSS = await outline();`;
  const evalIn = mv === 3
    ? (fn) => `(await api.scripting.executeScript({ target, func: ${fn} }))[0].result`
    : (fn) => `(await api.tabs.executeScript(tab.id, { code: "(" + (${fn}).toString() + ")()" }))[0]`;
  // Every wait below is on the browser's own state with a deadline, never a fixed
  // time: under load a tab can take many seconds to commit its page.
  const page = `
    (async () => {
      const api = browser; // promise-returning in MV2 too
      const out = {};
      const until = async (what, check, ms = 60000) => {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
          const v = await check();
          if (v) return v;
        }
        throw new Error("timed out waiting for " + what);
      };
      try {
        const tab = await until("the site tab", async () => (await api.tabs.query({})).find((t) => String(t.url).startsWith(${JSON.stringify(site)}) && t.status === "complete"));
        const target = { tabId: tab.id };
        const outline = async () => ${evalIn("() => getComputedStyle(document.documentElement).outlineColor")};
        const marker = async () => ${evalIn("() => document.documentElement.dataset.reg || ''")};
        // The "complete" a reload ends with, not the one the tab already had.
        const reload = async () => {
          let done = false;
          const seen = (id, info) => { if (id === tab.id && info.status === "complete") done = true; };
          api.tabs.onUpdated.addListener(seen);
          try {
            await api.tabs.reload(tab.id);
            await until("the site tab to reload", () => done);
          } finally {
            api.tabs.onUpdated.removeListener(seen);
          }
        };
        ${run}
      } catch (e) {
        out.error = String((e && e.message) || e);
      }
      document.title = JSON.stringify(out);
    })();`;
  const files = {
    "inject.js": '"injected";',
    "reg.js": 'document.documentElement.dataset.reg = "ran";',
    "s.css": "html { outline: 3px solid rgb(1, 2, 3); }",
    "html/page.js": page,
    "html/page.html": '<!doctype html><title>waiting</title><script src="/lavaduct-compat-shim.js"></script><script src="page.js"></script>',
  };
  files["lavaduct-compat-shim.js"] = buildShim({}, files);
  const manifest = mv === 3
    ? { manifest_version: 3, permissions: ["scripting", "tabs"], host_permissions: ["http://127.0.0.1/*"] }
    : { manifest_version: 2, permissions: ["tabs", "http://127.0.0.1/*"] };
  Object.assign(manifest, { name: `Injected paths MV${mv}`, version: "1", browser_specific_settings: { gecko: { id: `injected-paths-mv${mv}@lavaduct.test` } } });
  return { manifest, files };
}

async function runFromSubfolderPage(t, mv) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(SITE_HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const site = `http://127.0.0.1:${server.address().port}/`;
  const { manifest, files } = addon(mv, site);
  const title = await loadAddon(manifest, files, async ({ chrome, id }) => {
    const until = async (what, js) => {
      for (const end = Date.now() + 120_000; Date.now() < end; await sleep(100)) {
        const v = await chrome(js);
        if (v) return v;
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    await chrome(`(() => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const p = Services.scriptSecurityManager.getSystemPrincipal();
      globalThis.__pathsSite = win.gBrowser.addTab(${JSON.stringify(site)}, { triggeringPrincipal: p });
      globalThis.__pathsPage = () => win.gBrowser.addTab("moz-extension://" + WebExtensionPolicy.getByID(${JSON.stringify(id)}).mozExtensionHostname + "/html/page.html", { triggeringPrincipal: p });
      return 1;
    })()`);
    await until("the site to load", `(() => {
      const tab = globalThis.__pathsSite;
      return tab.linkedBrowser.currentURI.spec === ${JSON.stringify(site)} && !tab.hasAttribute("busy");
    })()`);
    await chrome(`(() => { globalThis.__pathsTab = globalThis.__pathsPage(); return 1; })()`);
    return await until("the page's result", `(() => {
      const title = globalThis.__pathsTab.linkedBrowser.contentTitle;
      return title && title.startsWith("{") ? title : "";
    })()`);
  });
  assert.ok(title.startsWith("{"), title);
  return JSON.parse(title);
}

test("an MV3 page in a subfolder injects, styles and registers files from the add-on's root", { skip: !firefox && "no Firefox installed", timeout: 300_000 }, async (t) => {
  assert.deepEqual(await runFromSubfolderPage(t, 3), {
    executeScript: "injected",
    insertCSS: "rgb(1, 2, 3)",
    removeCSS: "rgb(0, 0, 0)",
    registered: [["reg.js"]],
    registeredRan: "ran",
  });
});

test("an MV2 page in a subfolder runs tabs.executeScript and insertCSS files from the add-on's root", { skip: !firefox && "no Firefox installed", timeout: 300_000 }, async (t) => {
  assert.deepEqual(await runFromSubfolderPage(t, 2), {
    executeScript: "injected",
    insertCSS: "rgb(1, 2, 3)",
    removeCSS: "rgb(0, 0, 0)",
  });
});
