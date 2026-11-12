// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-proxy-settings-live-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { setUserPrefs } = await import("../dist/firefox/install.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// A Chrome VPN sets its proxy with chrome.proxy.settings.set in Chrome's shape.
// Firefox 160 refuses that call unless the add-on may run in private windows,
// and takes another shape anyway; Urban VPN's, Browsec's and Windscribe's
// Chrome builds never connected. The converted probe sets a fixed proxy from
// its background, then a PAC script from one of its pages, and the test reads
// which page loads reached a local proxy. The hosts don't resolve, so a page
// loads only through the proxy.
test(
  "Chrome's proxy.settings send a page's requests through the proxy, honour bypassList, and run a PAC script",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const seen = [];
    const proxy = http.createServer((req, res) => {
      seen.push(req.url);
      const host = new URL(req.url).hostname;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>via-proxy ${host}</title>`);
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => proxy.close());
    const port = proxy.address().port;

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Proxy Settings Probe", version: "1.0",
      permissions: ["proxy", "storage"],
      host_permissions: ["<all_urls>"],
      background: { service_worker: "sw.js" },
    }));
    writeFileSync(join(ext, "sw.js"), `chrome.runtime.onInstalled.addListener(() => {
  chrome.proxy.settings.set({ scope: "regular", value: { mode: "fixed_servers", rules: {
    singleProxy: { scheme: "http", host: "127.0.0.1", port: ${port} },
    bypassList: ["bypass.test", "*.skip.test"],
  } } }, () => { chrome.storage.local.set({ set: chrome.runtime.lastError ? chrome.runtime.lastError.message : "ok" }); });
});`);
    const pac = `function FindProxyForURL(url, host) { return dnsDomainIs(host, ".pac.test") ? "PROXY 127.0.0.1:${port}" : "DIRECT"; }`;
    writeFileSync(join(ext, "switch.html"), `<!doctype html><meta charset="utf-8"><script src="switch.js"></script>`);
    writeFileSync(join(ext, "switch.js"), `chrome.proxy.settings.set({ scope: "regular", value: { mode: "pac_script", pacScript: { data: ${JSON.stringify(pac)} } } })
  .then(() => chrome.proxy.settings.get({}))
  .then((d) => { document.title = "set " + d.value.mode + " " + d.levelOfControl; }, (e) => { document.title = "failed " + e.message; });`);
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    assert.ok(result.success, "the extension converts");

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    // Plain http, so HTTPS-First doesn't try the hosts over a tunnel first.
    setUserPrefs(profile, { "dom.security.https_first": false });
    const ff = await startPrivilegedFirefox(firefox, profile);
    const titles = {};
    let switchUrl = "";
    try {
      const id = await ff.installAddon(result.stagedPath);
      await sleep(2000);
      const uuid = await ff.chrome(`WebExtensionPolicy.getByID(${JSON.stringify(id)}).mozExtensionHostname`);
      const open = async (url, wait = 4000) => {
        await ff.chrome(`(() => { const w = Services.wm.getMostRecentWindow("navigator:browser"); const t = w.gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); w.gBrowser.selectedTab = t; globalThis.__probeTab = t; return 1; })()`);
        await sleep(wait);
        titles[url] = await ff.chrome("globalThis.__probeTab.linkedBrowser.contentTitle");
      };
      await open("http://proxied.test/a");
      await open("http://bypass.test/b");
      await open("http://deep.skip.test/c");
      switchUrl = `moz-extension://${uuid}/switch.html`;
      await open(switchUrl, 3000);
      await open("http://www.pac.test/d");
      await open("http://nopac.test/e");
    } finally {
      await ff.close();
    }
    assert.equal(titles["http://proxied.test/a"], "via-proxy proxied.test", "the page loads through the fixed proxy");
    assert.deepEqual(seen.filter((u) => /bypass|skip|nopac/.test(u)), [], "bypassList and the PAC's DIRECT go direct");
    assert.equal(titles[switchUrl], "set pac_script controlled_by_this_extension", "a page sets the PAC script, and get() reports it");
    assert.equal(titles["http://www.pac.test/d"], "via-proxy www.pac.test", "the PAC script's PROXY is used");
    assert.ok(seen.includes("http://proxied.test/a") && seen.includes("http://www.pac.test/d"), seen.join(", "));
  },
);
