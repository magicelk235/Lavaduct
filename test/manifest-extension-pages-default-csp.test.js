// An MV3 manifest without content_security_policy.extension_pages gets Firefox's
// default extension CSP, "script-src 'self'; upgrade-insecure-requests;". So every
// http:// request the background and extension pages make to a host that isn't
// loopback goes out as https://, and fails against an http-only server
// (Tampermonkey's GM_xmlhttpRequest to an http:// URL never answered). Chrome's
// default for MV3 is "script-src 'self';" with "object-src 'self'" enforced on
// top, which upgrades nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";
import { firefox, loadAddon } from "./firefox-load.js";

const CHROME_EXTENSION_PAGES_CSP = "script-src 'self'; object-src 'self';";
const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const plain = (extra = {}) => ({ manifest_version: 3, name: "Plain", version: "1.0", ...extra });

test("an MV3 manifest without an extension_pages CSP gets Chrome's default", () => {
  assert.deepEqual(transformManifest(plain(), [], options).content_security_policy, { extension_pages: CHROME_EXTENSION_PAGES_CSP });
  const own = "script-src 'self'; object-src 'self'; connect-src https://a.test";
  assert.equal(transformManifest(plain({ content_security_policy: { extension_pages: own } }), [], options).content_security_policy.extension_pages, own);
  assert.deepEqual(transformManifest(plain({ content_security_policy: { sandbox: "sandbox allow-scripts" } }), [], options).content_security_policy, {
    sandbox: "sandbox allow-scripts",
    extension_pages: CHROME_EXTENSION_PAGES_CSP,
  });
  assert.equal("content_security_policy" in transformManifest({ manifest_version: 2, name: "Old", version: "1.0" }, [], options), false, "MV2 has no upgrade in its default");
});

test("the analyzer and the report say the default is written", () => {
  const issue = analyzeManifest(plain(), { minFirefox: DEFAULT_MIN_FIREFOX }).issues.find((i) => i.message.includes("upgrade-insecure-requests"));
  assert.equal(issue?.autoFixed, true);
  const own = plain({ content_security_policy: { extension_pages: "script-src 'self'" } });
  assert.equal(analyzeManifest(own, { minFirefox: DEFAULT_MIN_FIREFOX }).issues.some((i) => i.message.includes("upgrade-insecure-requests")), false);
  assert.ok(summarizeManifestChanges(plain(), transformManifest(plain(), [], options)).some((c) => c.includes("extension_pages")));
});

test(
  "an extension page's http request to a host that isn't loopback stays http in Firefox",
  { skip: firefox ? false : "no Firefox install found", timeout: 120_000 },
  async (t) => {
    let report;
    const reported = new Promise((resolve) => (report = resolve));
    const server = http.createServer((req, res) => {
      if (req.url === "/report") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => { res.end(); report(body); });
        return;
      }
      res.writeHead(200, { "access-control-allow-origin": "*" });
      res.end("plain http");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const port = server.address().port;
    const out = transformManifest(plain({ host_permissions: ["<all_urls>"] }), [], { ...options, addonId: "pages-csp@example.com" });
    const result = await loadAddon(
      out,
      {
        "p.html": '<!doctype html><script src="p.js"></script>',
        // lavaduct.test resolves to this machine (network.dns.localDomains), but by
        // name it isn't loopback, which Firefox exempts from the upgrade.
        "p.js": `fetch("http://lavaduct.test:${port}/").then((r) => r.text(), (e) => e.name).then((r) =>
  fetch("http://127.0.0.1:${port}/report", { method: "POST", body: r }));`,
      },
      async ({ chrome, id }) => {
        await chrome(`(() => {
          Services.prefs.setStringPref("network.dns.localDomains", "lavaduct.test");
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          const url = "moz-extension://" + WebExtensionPolicy.getByID(${JSON.stringify(id)}).mozExtensionHostname + "/p.html";
          win.gBrowser.selectedTab = win.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          return 1;
        })()`);
        return reported;
      },
    );
    assert.equal(result, "plain http");
  },
);
