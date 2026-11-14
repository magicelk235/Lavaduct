// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-webrequest-errors-live-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// Ghostery counts a tracker as blocked when webRequest.onErrorOccurred reports
// "net::ERR_BLOCKED_BY_CLIENT", Chrome's error for a request an extension
// blocked; Firefox 160 reports a DNR block as NS_ERROR_ABORT, so its popup
// showed 1 tracker blocked of the 11 it had blocked on bbc.com. Aborts Chrome
// names "net::ERR_ABORTED" are NS_BINDING_ABORTED in Firefox. The converted probe
// blocks one image with a static DNR rule and one fetch with a blocking
// webRequest listener, aborts a third request, and reports what its
// onErrorOccurred listener saw to a local server.
test(
  "webRequest.onErrorOccurred reports Chrome's names for a request an extension blocked and one aborted",
  { skip: firefox ? false : "no Firefox install found", timeout: 180_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const seen = [];
    const held = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/log") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => { seen.push(JSON.parse(body)); res.end("ok"); });
        return;
      }
      if (req.url.startsWith("/slow/")) { held.push(res); return; }
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>page</title><img src="/blocked/pixel.gif"><script>
fetch("/cancelled/x").catch(() => {});
const c = new AbortController();
fetch("/slow/aborted", { signal: c.signal }).catch(() => {});
setTimeout(() => c.abort(), 300);
</script>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { for (const r of held) r.destroy(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Error Names Probe", version: "1.0",
      permissions: ["declarativeNetRequest", "webRequest", "webRequestBlocking"],
      host_permissions: ["<all_urls>"],
      background: { service_worker: "sw.js" },
      declarative_net_request: { rule_resources: [{ id: "block", enabled: true, path: "rules.json" }] },
    }));
    writeFileSync(join(ext, "rules.json"), JSON.stringify([
      { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "/blocked/", resourceTypes: ["image"] } },
    ]));
    writeFileSync(join(ext, "sw.js"), `const report = (o) => fetch(${JSON.stringify(base + "/log")}, { method: "POST", body: JSON.stringify(o) });
// What Ghostery's tracker count does with it.
const onError = (d) => { if (!d.url.endsWith("/log")) report({ url: d.url.replace(/^https?:\\/\\/[^/]+/, ""), error: d.error, blocked: d.error === "net::ERR_BLOCKED_BY_CLIENT" }); };
const unused = () => report({ url: "unused" });
chrome.webRequest.onErrorOccurred.addListener(onError, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(unused, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.removeListener(unused);
chrome.webRequest.onBeforeRequest.addListener((d) => ({ cancel: d.url.includes("/cancelled/") }), { urls: ["<all_urls>"] }, ["blocking"]);
report({ url: "ready", has: chrome.webRequest.onErrorOccurred.hasListener(onError), hasRemoved: chrome.webRequest.onErrorOccurred.hasListener(unused) });
`);
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    assert.ok(result.success, "the extension converts");

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const ff = await startPrivilegedFirefox(firefox, profile);
    const until = async (what, check) => {
      for (const end = Date.now() + 90_000; Date.now() < end; await sleep(100)) if (check()) return;
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(seen)}`);
    };
    try {
      await ff.installAddon(result.stagedPath);
      await until("the background to start", () => seen.some((e) => e.url === "ready"));
      await ff.chrome(`(() => { const w = Services.wm.getMostRecentWindow("navigator:browser"); w.gBrowser.selectedTab = w.gBrowser.addTab(${JSON.stringify(base + "/page")}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return 1; })()`);
      await until("three errors", () => ["/blocked/pixel.gif", "/cancelled/x", "/slow/aborted"].every((u) => seen.some((e) => e.url === u)));
    } finally {
      await ff.close();
    }
    const ready = seen.find((e) => e.url === "ready");
    assert.deepEqual({ has: ready.has, hasRemoved: ready.hasRemoved }, { has: true, hasRemoved: false }, "hasListener sees the add-on's own functions");
    assert.ok(!seen.some((e) => e.url === "unused"), "a removed listener isn't called");
    const errorOf = (u) => [...new Set(seen.filter((e) => e.url === u).map((e) => e.error))];
    assert.deepEqual(errorOf("/blocked/pixel.gif"), ["net::ERR_BLOCKED_BY_CLIENT"], "a DNR block");
    assert.deepEqual(errorOf("/cancelled/x"), ["net::ERR_BLOCKED_BY_CLIENT"], "a webRequest cancel");
    assert.deepEqual(errorOf("/slow/aborted"), ["net::ERR_ABORTED"], "an aborted fetch");
  },
);
