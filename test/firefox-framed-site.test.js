// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-framed-site-live-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { deriveChromeId } = await import("../dist/runtime/oauth-bridge.js");
const { BidiSession } = await import("../dist/firefox/bidi.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { readDebugLog } = await import("../dist/firefox/storage.js");

const firefox = selectFirefox(findFirefoxInstalls());

// An extension page that frames a site on externally_connectable, the way
// Claude in Chrome's side panel frames claude.ai. The framed site finds the
// extension from location.ancestorOrigins, asks it for its state with
// runtime.sendMessage, and then hands its parent a MessagePort. The background
// answers after setting a session rule built from Chrome's enum objects, as
// Claude's does; everything the three parts see goes to storage.local, where
// readDebugLog finds it.
const KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAframedSiteProbeKey";

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
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("panel.html") });
});
chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === "panel") report("panel", m.data);
});
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "report") {
    report("frame", msg.steps);
    return;
  }
  if (!msg || msg.type !== "host_info") return;
  (async () => {
    const dnr = chrome.declarativeNetRequest;
    await dnr.updateSessionRules({
      removeRuleIds: [7],
      addRules: [{
        id: 7,
        priority: 1,
        action: {
          type: dnr.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [{ header: "x-probe", operation: dnr.HeaderOperation.SET, value: "from-rule" }],
        },
        condition: { urlFilter: "|" + SITE + "/echo", resourceTypes: [dnr.ResourceType.XMLHTTPREQUEST] },
      }],
    });
    sendResponse({ ok: true, origin: sender.origin, url: sender.url });
  })().catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
`;

const PANEL = String.raw`
const frame = document.createElement("iframe");
frame.src = SITE + "/embed";
window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow || e.origin !== SITE || !e.data) return;
  if (e.data.type === "CHILD_READY") {
    const channel = new MessageChannel();
    channel.port1.onmessage = (m) => {
      if (m.data && m.data.type === "CALL") channel.port1.postMessage({ type: "RESULT", value: m.data.value * 2 });
    };
    frame.contentWindow.postMessage({ type: "CAPABILITIES" }, SITE, [channel.port2]);
  } else if (e.data.type === "CHILD_AUTH") {
    chrome.runtime.sendMessage({ type: "panel", data: { auth: e.data.payload } });
  }
});
document.body.appendChild(frame);
`;

const EMBED = String.raw`<!doctype html><title>Embed</title><script>
(async () => {
  const steps = {};
  const tell = () => chrome.runtime.sendMessage(steps.extensionId, { type: "report", steps: steps }, () => {});
  const ancestor = location.ancestorOrigins && location.ancestorOrigins[0];
  const m = ancestor ? ancestor.match(/^chrome-extension:\/\/([a-p]{32})$/) : null;
  steps.extensionId = m ? m[1] : null;
  steps.hostInfo = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 2500);
    chrome.runtime.sendMessage(steps.extensionId, { type: "host_info" }, (r) => {
      clearTimeout(timer);
      resolve(chrome.runtime.lastError ? { lastError: chrome.runtime.lastError.message } : r);
    });
  });
  steps.echoed = await fetch("/echo").then((r) => r.text(), (e) => "failed: " + e);
  tell();
  const parentOrigin = "chrome-extension://" + steps.extensionId;
  const port = await new Promise((resolve) => {
    addEventListener("message", function onMessage(e) {
      if (e.source !== window.parent || e.origin !== parentOrigin || !e.data || e.data.type !== "CAPABILITIES") return;
      removeEventListener("message", onMessage);
      resolve(e.ports[0]);
    });
    window.parent.postMessage({ type: "CHILD_READY" }, "*");
  });
  steps.result = await new Promise((resolve) => {
    port.onmessage = (e) => resolve(e.data);
    port.postMessage({ type: "CALL", value: 21 });
  });
  window.parent.postMessage({ type: "CHILD_AUTH", payload: { authenticated: true } }, parentOrigin);
  tell();
})();
</script>`;

test(
  "a site framed in the add-on's page reaches the add-on, which answers through a rule built from Chrome's enums, and hands its parent a port",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const chromeId = deriveChromeId({ key: KEY });
    const server = http.createServer((req, res) => {
      if (req.url === "/echo") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(req.headers["x-probe"] ?? ""));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": `frame-ancestors 'self' chrome-extension://${chromeId}`,
      });
      res.end(EMBED);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const site = `http://127.0.0.1:${server.address().port}`;

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Framed Site Probe", version: "1.0", key: KEY,
      permissions: ["declarativeNetRequest", "storage"],
      host_permissions: ["http://127.0.0.1/*"],
      background: { service_worker: "sw.js" },
      externally_connectable: { matches: ["http://127.0.0.1/*"] },
    }));
    writeFileSync(join(ext, "sw.js"), `const SITE = "${site}";\n${BACKGROUND}`);
    writeFileSync(join(ext, "panel.html"), `<!doctype html><meta charset="utf-8"><title>Panel</title><body><script src="panel.js"></script></body>`);
    writeFileSync(join(ext, "panel.js"), `const SITE = "${site}";\n${PANEL}`);
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    assert.ok(result.success, "the extension converts");

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const session = await BidiSession.start(firefox, profile);
    let seen = {};
    try {
      const id = await session.installExtension(result.stagedPath);
      for (let i = 0; i < 120 && !(seen.frame?.result && seen.panel); i++) {
        await sleep(500);
        try {
          for (const e of readDebugLog(profile, id).entries) {
            const m = JSON.parse(e.msg);
            seen[m.step] = m.data;
          }
        } catch {
          // Firefox hasn't written the storage yet.
        }
      }
    } finally {
      await session.closeBrowser();
    }

    const frame = seen.frame ?? {};
    assert.equal(frame.extensionId, chromeId, "the site finds the extension's Chrome ID in its parent's origin");
    assert.deepEqual(frame.hostInfo, { ok: true, origin: site, url: `${site}/embed` });
    assert.equal(frame.echoed, "from-rule", "the rule the extension set applies to the site's requests");
    assert.deepEqual(frame.result, { type: "RESULT", value: 42 }, "a call over the parent's port comes back");
    assert.deepEqual(seen.panel, { auth: { authenticated: true } }, "a message the site addresses to the Chrome origin reaches the parent");
  },
);
