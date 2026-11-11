// Chrome gives manifest sandbox pages a default CSP that allows eval and inline
// scripts. Firefox applies script-src 'self' to them unless the manifest sets a
// sandbox CSP, so eval in a converted sandbox page is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";
import { firefox, loadAddon } from "./firefox-load.js";

const CHROME_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';";
const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = (mv, extra = {}) => ({ manifest_version: mv, name: "Sandboxed", version: "1.0", sandbox: { pages: ["s.html"] }, ...extra });

test("MV3 sandbox pages get Chrome's default sandbox CSP beside the manifest's own", () => {
  assert.deepEqual(transformManifest(manifest(3), [], options).content_security_policy, { sandbox: CHROME_SANDBOX_CSP });
  const pages = "script-src 'self'; object-src 'self'";
  assert.deepEqual(transformManifest(manifest(3, { content_security_policy: { extension_pages: pages } }), [], options).content_security_policy, {
    extension_pages: pages,
    sandbox: CHROME_SANDBOX_CSP,
  });
});

test("MV2 sandbox pages get it in sandbox.content_security_policy", () => {
  const out = transformManifest(manifest(2, { content_security_policy: "script-src 'self'; object-src 'self'" }), [], options);
  assert.deepEqual(out.sandbox, { pages: ["s.html"], content_security_policy: CHROME_SANDBOX_CSP });
  assert.equal(out.content_security_policy, "script-src 'self'; object-src 'self'");
});

test("an explicit sandbox CSP, or no sandbox pages, is left alone", () => {
  const own = "sandbox allow-scripts; script-src 'self'";
  assert.deepEqual(transformManifest(manifest(3, { content_security_policy: { sandbox: own } }), [], options).content_security_policy, { sandbox: own });
  assert.equal(transformManifest(manifest(2, { sandbox: { pages: ["s.html"], content_security_policy: own } }), [], options).sandbox.content_security_policy, own);
  assert.equal("content_security_policy" in transformManifest({ manifest_version: 3, name: "Plain", version: "1.0" }, [], options), false);
  assert.equal("content_security_policy" in transformManifest(manifest(3, { sandbox: { pages: [] } }), [], options), false);
});

test("the analyzer and the report say the default is written", () => {
  const { issues } = analyzeManifest(manifest(3), { minFirefox: DEFAULT_MIN_FIREFOX });
  const [issue] = issues.filter((i) => i.message.includes("sandbox CSP"));
  assert.equal(issue.autoFixed, true);
  assert.equal(analyzeManifest(manifest(3, { content_security_policy: { sandbox: "sandbox allow-scripts" } }), { minFirefox: DEFAULT_MIN_FIREFOX }).issues.filter((i) => i.message.includes("sandbox CSP")).length, 0);
  const before = manifest(3);
  assert.ok(summarizeManifestChanges(before, transformManifest(before, [], options)).some((c) => c.includes("sandbox")));
});

for (const mv of [3, 2]) {
  test(`eval runs in a converted MV${mv} sandbox page in Firefox`, { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
    let report;
    const reported = new Promise((resolve) => (report = resolve));
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.end();
        report(body);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const out = transformManifest(manifest(mv, { background: { scripts: ["bg.js"] } }), [], { ...options, addonId: `sandbox-csp-${mv}@example.com` });
    const result = await loadAddon(
      out,
      {
        "bg.js": 'browser.tabs.create({ url: "s.html" });',
        "s.html": '<!doctype html><script src="sb.js"></script>',
        "sb.js": `let r; try { r = String(eval("1 + 1")); } catch (e) { r = e.name; }
fetch("http://127.0.0.1:${server.address().port}/", { method: "POST", mode: "no-cors", body: r });`,
      },
      () => reported,
    );
    assert.equal(result, "2");
  });
}
