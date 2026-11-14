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
const { setUserPrefs } = await import("../dist/firefox/install.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// Ghostery counts a tracker as blocked when webRequest.onErrorOccurred reports
// "net::ERR_BLOCKED_BY_CLIENT", Chrome's error for a request an extension
// blocked; Firefox 160 reports a DNR block as NS_ERROR_ABORT, so its popup
// showed 1 tracker blocked of the 11 it had blocked on bbc.com. Aborts Chrome
// names "net::ERR_ABORTED" are NS_BINDING_ABORTED in Firefox. The converted probe
// blocks one image with a static DNR rule and one fetch with a blocking
// webRequest listener, aborts a third request, and reports what its
// onErrorOccurred listener saw to a local server. Firefox also ends
// identity.launchWebAuthFlow's navigation to the redirect URL with
// NS_ERROR_ABORT, which is no block; downloads (finished or cancelled) and a
// request a redirect replaced report no error at all. The probe runs a sign-in
// flow, two downloads and a redirect to check those too. (The loopback
// redirect, http://127.0.0.1/mozoauth2/…, can't be run here: with nothing on
// port 80 its navigation fails with NS_ERROR_CONNECTION_REFUSED before Firefox
// stops it; shim-webrequest-error-names.test.js covers its URL.)
test(
  "webRequest.onErrorOccurred reports Chrome's names for a request an extension blocked and one aborted, and nothing else as blocked",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const seen = [];
    const held = [];
    let base = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/log") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => { seen.push(JSON.parse(body)); res.end("ok"); });
        return;
      }
      if (req.url.startsWith("/slow/")) { held.push(res); return; }
      if (req.url.startsWith("/dl/")) {
        if (req.url.includes("slow")) {
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "10000000" });
          res.write("x".repeat(65536));
          held.push(res);
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end("downloaded");
        return;
      }
      if (req.url === "/redir") { res.writeHead(302, { location: "/after-redirect" }); res.end(); return; }
      if (req.url.startsWith("/auth?")) {
        const to = new URL(req.url, base).searchParams.get("to");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>sign in</title><script>setTimeout(() => { location.href = ${JSON.stringify(to + "?code=1")}; }, 300);</script>`);
        return;
      }
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>page</title><img src="/blocked/pixel.gif"><img src="/redir"><script>
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
    base = `http://127.0.0.1:${server.address().port}`;

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Error Names Probe", version: "1.0",
      permissions: ["declarativeNetRequest", "webRequest", "webRequestBlocking", "identity"],
      host_permissions: ["<all_urls>"],
      background: { service_worker: "sw.js" },
      declarative_net_request: { rule_resources: [{ id: "block", enabled: true, path: "rules.json" }] },
    }));
    writeFileSync(join(ext, "auth.html"), `<!doctype html><script src="auth.js"></script>`);
    writeFileSync(join(ext, "auth.js"), `chrome.runtime.sendMessage({ auth: location.hash.slice(1) });`);
    writeFileSync(join(ext, "rules.json"), JSON.stringify([
      { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "/blocked/", resourceTypes: ["image"] } },
    ]));
    writeFileSync(join(ext, "sw.js"), `const report = (o) => fetch(${JSON.stringify(base + "/log")}, { method: "POST", body: JSON.stringify(o) });
// What Ghostery's tracker count does with it.
const local = (u) => u.startsWith(${JSON.stringify(base)}) ? u.slice(${base.length}) : u;
const onError = (d) => { if (!d.url.endsWith("/log")) report({ url: local(d.url), error: d.error, blocked: d.error === "net::ERR_BLOCKED_BY_CLIENT" }); };
chrome.webRequest.onResponseStarted.addListener((d) => { if (d.url.includes("/dl/")) report({ url: local(d.url), started: true }); }, { urls: ["<all_urls>"] });
chrome.webRequest.onBeforeRedirect.addListener((d) => report({ url: local(d.url), redirected: true }), { urls: ["<all_urls>"] });
const own = new URL(chrome.identity.getRedirectURL());
const redirects = { default: own.href };
chrome.runtime.onMessage.addListener((m) => {
  if (!m.auth) return;
  const url = ${JSON.stringify(base + "/auth?to=")} + encodeURIComponent(redirects[m.auth]);
  chrome.identity.launchWebAuthFlow({ url, interactive: true }).then((u) => report({ url: "auth " + m.auth, result: u, redirect: redirects[m.auth] }), (e) => report({ url: "auth " + m.auth, result: "failed " + e.message }));
});
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
    const downloads = join(scratch, "downloads");
    mkdirSync(downloads);
    setUserPrefs(profile, {
      "browser.download.dir": JSON.stringify(downloads), "browser.download.folderList": 2, "browser.download.useDownloadDir": true,
      "browser.download.always_ask_before_handling_new_types": false,
    });
    const ff = await startPrivilegedFirefox(firefox, profile);
    const until = async (what, check) => {
      for (const end = Date.now() + 90_000; Date.now() < end; await sleep(100)) if (check()) return;
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(seen)}`);
    };
    try {
      const id = await ff.installAddon(result.stagedPath);
      await until("the background to start", () => seen.some((e) => e.url === "ready"));
      const open = (url) => ff.chrome(`(() => { const w = Services.wm.getMostRecentWindow("navigator:browser"); w.gBrowser.selectedTab = w.gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return 1; })()`);
      await open(base + "/page");
      await until("three errors", () => ["/blocked/pixel.gif", "/cancelled/x", "/slow/aborted"].every((u) => seen.some((e) => e.url === u && e.error)));
      // A navigation that becomes a download and finishes, and one the user cancels.
      await open(base + "/dl/done.bin");
      await open(base + "/dl/slow.bin");
      await until("the downloads to start", () => ["/dl/done.bin", "/dl/slow.bin"].every((u) => seen.some((e) => e.url === u && e.started)));
      const states = await ff.chrome(`(async () => {
        const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
        const list = await Downloads.getList(Downloads.ALL);
        const ready = async () => { const all = await list.getAll(); return all.some((d) => d.source.url.includes("done") && d.succeeded) && all.some((d) => d.source.url.includes("slow")); };
        for (let i = 0; i < 300 && !(await ready()); i++) await new Promise((r) => setTimeout(r, 100));
        for (const d of await list.getAll()) if (d.source.url.includes("slow") && !d.stopped) await d.cancel();
        return JSON.stringify((await list.getAll()).map((d) => d.source.url.split("/").pop() + " " + (d.succeeded ? "succeeded" : d.canceled ? "canceled" : "other")).sort());
      })()`);
      assert.deepEqual(JSON.parse(states), ["done.bin succeeded", "slow.bin canceled"]);
      const uuid = await ff.chrome(`WebExtensionPolicy.getByID(${JSON.stringify(id)}).mozExtensionHostname`);
      await open(`moz-extension://${uuid}/auth.html#default`);
      await until("the sign-in flow", () => seen.some((e) => e.url === "auth default"));
      // The flow resolves as soon as Firefox stops the navigation; its error event may follow.
      await until("the redirect URL's error", () => seen.some((e) => e.error && /code=1$/.test(e.url)));
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
    const flow = seen.find((e) => e.url === "auth default");
    assert.equal(flow.result, flow.redirect + "?code=1", "the sign-in flow finishes");
    assert.deepEqual(errorOf(flow.redirect + "?code=1"), ["NS_ERROR_ABORT"], "the flow's stopped redirect keeps Firefox's name, not a block");
    assert.ok(seen.some((e) => e.url === "/redir" && e.redirected), "the redirect happened");
    assert.deepEqual(seen.filter((e) => e.error && /^\/(dl|redir)/.test(e.url)), [], "downloads and a redirected request report no error");
  },
);
