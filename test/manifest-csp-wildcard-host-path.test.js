// A CSP source can name any host with a bare "*" and still restrict the path:
// http://*/api/test. Firefox's parser refuses the wildcard when a path follows
// it ("Couldn't parse invalid host") and drops the source, so a converted
// add-on's pages can no longer fetch what Chrome lets them (Browsec's server
// checks). Firefox takes the wildcard when a port follows it, and a source
// without a port means the scheme's default port, so the transform writes that
// port in.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";
import { firefox, loadAddon } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const PAGES = "script-src 'self'; connect-src 'self' https: http://*/api/test ws://*/socket wss://*/s https://*/x http://*.example.com/* http://* http://*:8080/y";

test("a wildcard host followed by a path gets the scheme's default port", () => {
  const out = transformManifest({ manifest_version: 3, name: "x", version: "1.0", content_security_policy: { extension_pages: PAGES, sandbox: "sandbox allow-scripts; connect-src http://*/a" } }, [], options);
  assert.equal(
    out.content_security_policy.extension_pages,
    "script-src 'self'; connect-src 'self' https: http://*:80/api/test ws://*:80/socket wss://*:443/s https://*:443/x http://*.example.com/* http://* http://*:8080/y",
  );
  assert.equal(out.content_security_policy.sandbox, "sandbox allow-scripts; connect-src http://*:80/a");
});

test("MV2's string CSP and sandbox CSP get the same rewrite", () => {
  const out = transformManifest({ manifest_version: 2, name: "x", version: "1.0", content_security_policy: "connect-src http://*/api", sandbox: { pages: ["s.html"], content_security_policy: "sandbox; connect-src https://*/b" } }, [], options);
  assert.equal(out.content_security_policy, "connect-src http://*:80/api");
  assert.equal(out.sandbox.content_security_policy, "sandbox; connect-src https://*:443/b");
});

test("a policy without such a source is left alone", () => {
  const csp = { extension_pages: "script-src 'self'; connect-src 'self' http://*.example.com/api http://*" };
  assert.deepEqual(transformManifest({ manifest_version: 3, name: "x", version: "1.0", content_security_policy: csp }, [], options).content_security_policy, csp);
});

test("the analyzer and the report name the rewrite", () => {
  const before = { manifest_version: 3, name: "x", version: "1.0", content_security_policy: { extension_pages: PAGES } };
  const [issue] = analyzeManifest(before, { minFirefox: DEFAULT_MIN_FIREFOX }).issues.filter((i) => i.message.includes("http://*/api/test"));
  assert.ok(issue, "no issue names the source");
  assert.equal(issue.autoFixed, true);
  const changes = summarizeManifestChanges(before, transformManifest(before, [], options));
  assert.ok(changes.some((c) => c.includes("`http://*/api/test`")), changes.join("\n"));
});

test("Firefox lets the converted page fetch through the source", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  // Firefox reaches http://probe.test through this server as its HTTP proxy, so
  // a request it lets through shows up here; one the CSP blocks never does.
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "access-control-allow-origin": "*" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const out = transformManifest(
    {
      manifest_version: 3,
      name: "csp",
      version: "1.0",
      host_permissions: ["<all_urls>"],
      content_security_policy: { extension_pages: "script-src 'self'; connect-src 'self' http://*/api/test" },
    },
    [],
    { ...options, addonId: "csp-wildcard-path@example.com" },
  );
  const result = await loadAddon(out, { "p.html": '<!doctype html><script src="p.js"></script>', "p.js": 'fetch("http://probe.test/api/test").then(() => (document.title = "fetched"), (e) => (document.title = "refused " + e));' }, async ({ chrome, id }) => {
    return await chrome(`(async () => {
      const p = Services.prefs;
      p.setIntPref("network.proxy.type", 1);
      p.setStringPref("network.proxy.http", "127.0.0.1");
      p.setIntPref("network.proxy.http_port", ${server.address().port});
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const host = WebExtensionPolicy.getByID(${JSON.stringify("csp-wildcard-path@example.com")}).mozExtensionHostname;
      const tab = win.gBrowser.addTab("moz-extension://" + host + "/p.html", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      for (let i = 0; i < 100; i++) {
        const title = tab.linkedBrowser.contentTitle;
        if (title === "fetched" || title.startsWith("refused")) return title;
        await new Promise((r) => win.setTimeout(r, 100));
      }
      return "timed out: " + tab.linkedBrowser.contentTitle;
    })()`);
  });
  assert.equal(result, "fetched");
  assert.deepEqual(seen, ["http://probe.test/api/test"]);
});
