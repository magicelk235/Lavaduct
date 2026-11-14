// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildShim } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// Chrome delivers tabs.sendMessage to every context of the add-on in the tab
// with a listener, a USER_SCRIPT world with messaging included. Firefox only
// delivers it to content scripts, and rejects "Receiving end does not exist"
// when only a user script listens: Violentmonkey's GM_xmlhttpRequest answers,
// which its background sends to the tab, never arrived.

const USER_SCRIPT = `
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (!m.ping) return;
  setTimeout(() => send({ pong: m.ping, frame: location.pathname, fromAddon: sender.id === chrome.runtime.id }), 10);
  return true;
});
chrome.runtime.onMessage.addListener((m) => (m.p ? Promise.resolve("promised " + m.p) : undefined));
`;

// The background reports through storage.local, which the test reads from
// Firefox's parent process.
const BACKGROUND = `
browser.permissions.onAdded.addListener(async (p) => {
  if (!p.permissions.includes("userScripts")) return;
  await chrome.userScripts.configureWorld({ messaging: true });
  await chrome.userScripts.register([{ id: "s", matches: ["http://127.0.0.1/*"], js: [{ code: ${JSON.stringify(USER_SCRIPT)} }], runAt: "document_start" }]);
  await chrome.storage.local.set({ registered: true });
});
const settle = (p) => p.then((v) => (v === undefined ? "undefined" : v), (e) => "rejected: " + e.message);
async function probe() {
  const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
  const [other] = await chrome.tabs.query({ url: "http://localhost/*" });
  const r = {};
  r.async = await settle(chrome.tabs.sendMessage(tab.id, { ping: 7 }));
  r.callback = await new Promise((res) => chrome.tabs.sendMessage(tab.id, { ping: 8 }, { frameId: 0 }, (v) => res([v, chrome.runtime.lastError ? chrome.runtime.lastError.message : null])));
  r.promise = await settle(chrome.tabs.sendMessage(tab.id, { p: 3 }));
  // Chrome: a promise nobody answers resolves, a callback gets lastError.
  r.unanswered = await settle(chrome.tabs.sendMessage(tab.id, { other: 1 }));
  r.unansweredCallback = await new Promise((res) => chrome.tabs.sendMessage(tab.id, { other: 2 }, (v) => res([v === undefined ? "undefined" : v, chrome.runtime.lastError ? chrome.runtime.lastError.message : null])));
  r.nobody = await settle(chrome.tabs.sendMessage(other.id, { ping: 9 }));
  return r;
}
// The probe runs once both of the test's tabs have loaded.
let probed = false;
chrome.tabs.onUpdated.addListener(async () => {
  const done = await chrome.tabs.query({ url: ["http://127.0.0.1/*", "http://localhost/*"], status: "complete" });
  if (probed || done.length < 2) return;
  probed = true;
  probe().then((r) => chrome.storage.local.set({ result: JSON.stringify(r) }), (e) => chrome.storage.local.set({ result: "probe failed: " + e }));
});
chrome.storage.local.set({ ready: true });
`;

test("tabs.sendMessage reaches a USER_SCRIPT world's onMessage, as in Chrome", { skip: !firefox && "no Firefox installed", timeout: 180_000 }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>page</title><p>page</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { port } = server.address();
  const urls = [`http://127.0.0.1:${port}/page`, `http://localhost:${port}/other`];

  const manifest = {
    manifest_version: 3, name: "User script tab messages", version: "1",
    browser_specific_settings: { gecko: { id: "user-script-tab-message@lavaduct.test" } },
    permissions: ["tabs", "storage"],
    optional_permissions: ["userScripts"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    background: { scripts: ["lavaduct-compat-shim.js", "background.js"] },
  };
  const files = { "background.js": BACKGROUND };
  files["lavaduct-compat-shim.js"] = buildShim({ userScripts: true }, files);

  const result = await loadAddon(manifest, files, async ({ chrome, id }) => {
    const policy = `WebExtensionPolicy.getByID(${JSON.stringify(id)})`;
    const stored = (key) => `(async () => {
      const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
      const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(${policy}.extension));
      return (await db.get([${JSON.stringify(key)}]))[${JSON.stringify(key)}];
    })()`;
    // Each check returns within the devtools reply timeout, however slowly a
    // loaded machine gets there; the test's own timeout bounds the whole wait.
    const until = async (condition) => {
      while (!(await chrome(`(async () => {
        for (const end = Date.now() + 10000; Date.now() < end;) {
          if (await (${condition})) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      })()`)));
    };
    await until(stored("ready"));
    // What turning the permission on in about:addons does.
    await chrome(`(async () => {
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      await ExtensionPermissions.add(${JSON.stringify(id)}, { permissions: ["userScripts"], origins: [] }, ${policy}.extension);
      return 1;
    })()`);
    await until(stored("registered"));
    await chrome(`(() => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      for (const u of ${JSON.stringify(urls)}) win.gBrowser.addTab(u, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      return 1;
    })()`);
    await until(stored("result"));
    return chrome(stored("result"));
  });
  assert.ok(result.startsWith("{"), result);
  assert.deepEqual(JSON.parse(result), {
    async: { pong: 7, frame: "/page", fromAddon: true },
    callback: [{ pong: 8, frame: "/page", fromAddon: true }, null],
    promise: "promised 3",
    unanswered: "undefined",
    unansweredCallback: ["undefined", "The message port closed before a response was received."],
    nobody: "rejected: Could not establish connection. Receiving end does not exist.",
  });
});
