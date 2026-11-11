// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-bridge-onconnect-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { applyOAuthBridge, deriveChromeId, BRIDGE_BACKGROUND } = await import("../dist/runtime/oauth-bridge.js");
const { fakeBrowser } = await import("./shim-sandbox.js");
const { BidiSession } = await import("../dist/firefox/bidi.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { readDebugLog } = await import("../dist/firefox/storage.js");

const firefox = selectFirefox(findFirefoxInstalls());

test("the extension's onConnect listeners never see the relay's ports, and keep their identity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-onconnect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "sw.js"), "");
  applyOAuthBridge(dir, {
    manifest_version: 3, name: "T", version: "1",
    background: { service_worker: "sw.js" },
    externally_connectable: { matches: ["https://app.example.com/*"] },
  }, "abcdefghijklmnopabcdefghijklmnop");
  const browser = fakeBrowser();
  const sandbox = { console, setTimeout, clearTimeout, Promise, JSON, URL, WeakMap, browser, chrome: browser };
  sandbox.self = sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(dir, BRIDGE_BACKGROUND), "utf-8"), sandbox);

  const seen = [];
  const listener = (port) => { seen.push(port.name); };
  browser.runtime.onConnect.addListener(listener);
  assert.equal(browser.runtime.onConnect.hasListener(listener), true);
  const port = (name) => ({ name, sender: { url: "https://app.example.com/" }, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } });
  browser.runtime.onConnect.fire(port("__pageBridge"));
  browser.runtime.onConnect.fire(port("mine"));
  assert.deepEqual(seen, ["mine"]);
  browser.runtime.onConnect.removeListener(listener);
  assert.equal(browser.runtime.onConnect.hasListener(listener), false);
  browser.runtime.onConnect.fire(port("mine"));
  assert.deepEqual(seen, ["mine"]);
});

// The page bridge carries a page's message to the background over a
// runtime.connect port. In Chrome a web page's message never reaches
// runtime.onConnect, so an extension's onConnect listener may treat every port
// as one of its own: here it keeps one port per tab and turns away names it
// doesn't know. Neither may cost the page its answer, or the extension its own
// content script's port.
const KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAbridgeOnConnectKey";

const BACKGROUND = String.raw`
const LOG = "__viaduct_debug_log__";
let chain = Promise.resolve();
function report(step, data) {
  chain = chain.then(async () => {
    const list = (await chrome.storage.local.get(LOG))[LOG] || [];
    list.push({ t: Date.now(), ctx: "background", msg: JSON.stringify({ step, data }) });
    await chrome.storage.local.set({ [LOG]: list });
  }).catch(() => {});
}
const seen = [];
const tabs = {};
chrome.runtime.onInstalled.addListener(() => { chrome.tabs.create({ url: SITE + "/page" }); });
chrome.runtime.onConnect.addListener((port) => {
  seen.push(port.name);
  if (port.name !== "mine") { port.disconnect(); return; }
  tabs[port.sender.tab.id] = port;
  port.onDisconnect.addListener(() => { delete tabs[port.sender.tab.id]; });
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "report") report("page", { reply: msg.reply, onConnect: seen, ownPort: !!tabs[sender.tab.id] });
});
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  setTimeout(() => sendResponse({ pong: true }), 50);
  return true;
});
`;

// The page's result comes back through the extension's own content script, not
// through the bridge under test.
const CONTENT = `chrome.runtime.connect({ name: "mine" });
window.addEventListener("message", (e) => {
  if (e.source === window && e.data && e.data.probeReply) chrome.runtime.sendMessage({ type: "report", reply: e.data.probeReply.value });
});`;

const PAGE = (id) => String.raw`<!doctype html><title>Page</title><script>
setTimeout(() => {
  chrome.runtime.sendMessage("${id}", { type: "ping" }, (reply) => {
    const r = chrome.runtime.lastError ? { lastError: chrome.runtime.lastError.message } : reply;
    setTimeout(() => window.postMessage({ probeReply: { value: r } }, "*"), 300);
  });
}, 500);
</script>`;

test(
  "a bridged page's message never reaches the extension's onConnect listeners",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const chromeId = deriveChromeId({ key: KEY });
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE(chromeId));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const site = `http://127.0.0.1:${server.address().port}`;

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Bridge onConnect Probe", version: "1.0", key: KEY,
      permissions: ["storage", "tabs"],
      host_permissions: ["http://127.0.0.1/*"],
      background: { service_worker: "sw.js" },
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["cs.js"] }],
      externally_connectable: { matches: ["http://127.0.0.1/*"] },
    }));
    writeFileSync(join(ext, "sw.js"), `const SITE = "${site}";\n${BACKGROUND}`);
    writeFileSync(join(ext, "cs.js"), CONTENT);
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    assert.ok(result.success, "the extension converts");

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const session = await BidiSession.start(firefox, profile);
    let seen = null;
    try {
      const id = await session.installExtension(result.stagedPath);
      for (let i = 0; i < 60 && !seen; i++) {
        await sleep(500);
        try {
          for (const e of readDebugLog(profile, id).entries) {
            const m = JSON.parse(e.msg);
            if (m.step === "page") seen = m.data;
          }
        } catch {
          // Firefox hasn't written the storage yet.
        }
      }
    } finally {
      await session.closeBrowser();
    }

    assert.ok(seen, "the page reported back");
    assert.deepEqual(seen.reply, { pong: true }, "the page gets the answer");
    assert.deepEqual(seen.onConnect, ["mine"], "the extension's onConnect only sees its own port");
    assert.equal(seen.ownPort, true, "the extension keeps its content script's port");
  },
);
