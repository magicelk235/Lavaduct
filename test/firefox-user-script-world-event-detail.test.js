// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildShim } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// A Chrome build's user script talks to the page and to a content script
// through CustomEvents, as Violentmonkey's bridge and Surfingkeys' snippets do.
// Chrome clones a detail into the world that reads it and defines no cloneInto
// there. Firefox hands the USER_SCRIPT world the page's object through an Xray
// that refuses this world's objects as property values, gives the page this
// world's objects unreadable, and defines cloneInto, so Violentmonkey took its
// Firefox path and its GM_xmlhttpRequest never answered. The page script
// reports what both sides read in the document title.

const USER_SCRIPT = `
const R = { cloneInto: typeof cloneInto, exportFunction: typeof exportFunction, createObjectIn: typeof createObjectIn };
document.addEventListener("t-page", (e) => {
  const msg = e.detail;
  // Violentmonkey's HttpRequest: drop the prototype, then add a property.
  try { Object.setPrototypeOf(msg, null); msg.ua = ["agent"]; R.page = { a: msg.a[0], ua: msg.ua[0] }; } catch (err) { R.page = String(err); }
});
document.addEventListener("t-content", (e) => { try { R.content = e.detail.shift(); } catch (err) { R.content = String(err); } });
let own;
document.addEventListener("t-reply", (e) => { own = e.detail; });
document.addEventListener("t-go", () => {
  const sent = { list: [1, 2], s: "x" };
  document.dispatchEvent(new CustomEvent("t-reply", { detail: sent }));
  R.own = own === sent;
  document.documentElement.setAttribute("data-us", JSON.stringify(R));
});
`;

const MAIN = `
let reply;
document.addEventListener("t-reply", (e) => { try { reply = JSON.stringify(e.detail); } catch (err) { reply = String(err); } });
addEventListener("DOMContentLoaded", () => {
  document.dispatchEvent(new CustomEvent("t-page", { detail: { a: [5] } }));
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent("t-go"));
    document.title = JSON.stringify({ us: JSON.parse(document.documentElement.getAttribute("data-us") || "null"), reply });
  }, 300);
});
`;

const ISOLATED = `addEventListener("DOMContentLoaded", () => document.dispatchEvent(new CustomEvent("t-content", { detail: ["first", 2] })));`;

// The background reports through storage.local, which the test reads from
// Firefox's parent process.
const BACKGROUND = `
browser.permissions.onAdded.addListener(async (p) => {
  if (!p.permissions.includes("userScripts")) return;
  await chrome.userScripts.register([{ id: "s", matches: ["http://127.0.0.1/*"], js: [{ code: ${JSON.stringify(USER_SCRIPT)} }], runAt: "document_start" }]);
  await chrome.storage.local.set({ registered: true });
});
chrome.storage.local.set({ ready: true });
`;

test("the USER_SCRIPT world reads CustomEvent details as its own, its details reach the page, and it has no cloneInto, as in Chrome", { skip: !firefox && "no Firefox installed", timeout: 180_000 }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>waiting</title><p>page</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/page`;

  const manifest = {
    manifest_version: 3, name: "User script world", version: "1",
    browser_specific_settings: { gecko: { id: "user-script-world@lavaduct.test" } },
    permissions: ["storage"],
    optional_permissions: ["userScripts"],
    host_permissions: ["http://127.0.0.1/*"],
    background: { scripts: ["lavaduct-compat-shim.js", "background.js"] },
    content_scripts: [
      { matches: ["http://127.0.0.1/*"], js: ["main.js"], run_at: "document_start", world: "MAIN" },
      { matches: ["http://127.0.0.1/*"], js: ["lavaduct-compat-shim.js", "isolated.js"], run_at: "document_start" },
    ],
  };
  const files = { "background.js": BACKGROUND, "main.js": MAIN, "isolated.js": ISOLATED };
  files["lavaduct-compat-shim.js"] = buildShim({ userScripts: true }, files);

  const title = await loadAddon(manifest, files, async ({ chrome, id }) => {
    const policy = `WebExtensionPolicy.getByID(${JSON.stringify(id)})`;
    // Each check returns within the devtools reply timeout, however slowly a
    // loaded machine gets there; the test's own timeout bounds the whole wait.
    const until = async (key) => {
      while (!(await chrome(`(async () => {
        const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
        const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(${policy}.extension));
        for (const end = Date.now() + 10000; Date.now() < end;) {
          if ((await db.get([${JSON.stringify(key)}]))[${JSON.stringify(key)}]) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      })()`)));
    };
    await until("ready");
    // What turning the permission on in about:addons does.
    await chrome(`(async () => {
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      await ExtensionPermissions.add(${JSON.stringify(id)}, { permissions: ["userScripts"], origins: [] }, ${policy}.extension);
      return 1;
    })()`);
    await until("registered");
    await chrome(`(() => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      globalThis.__userScriptWorldTab = win.gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      return 1;
    })()`);
    for (;;) {
      const state = JSON.parse(await chrome(`(async () => {
        const browser = globalThis.__userScriptWorldTab.linkedBrowser;
        const done = () => browser.currentURI.spec === ${JSON.stringify(url)} && browser.contentTitle.startsWith("{");
        for (const end = Date.now() + 10000; !done() && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
        return JSON.stringify({ done: done(), title: browser.contentTitle });
      })()`));
      if (state.done) return state.title;
    }
  });
  const result = JSON.parse(title);
  assert.deepEqual(result.us, {
    cloneInto: "undefined", exportFunction: "undefined", createObjectIn: "undefined",
    page: { a: 5, ua: "agent" },
    content: "first",
    own: true,
  });
  assert.equal(result.reply, '{"list":[1,2],"s":"x"}', "the page reads the user script's detail");
});
