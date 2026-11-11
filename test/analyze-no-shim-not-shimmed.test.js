// --no-shim builds the add-on without the runtime shim and --no-oauth-bridge
// without the page bridge, but the analysis still said "[shimmed]", "the shim keeps
// the feature working" and "the page bridge relays their calls". Those features are
// missing from such a build, and the report must say so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeManifest } from "../dist/manifest/manifest.js";
import { scanExtension } from "../dist/analyze/analyze.js";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

const MIN = "153.0";
const manifest = {
  manifest_version: 3,
  name: "Shimmed",
  version: "1",
  permissions: ["offscreen", "sidePanel"],
  background: { service_worker: "bg.js" },
  externally_connectable: { matches: ["https://app.example.com/*"] },
};

function source(t) {
  const dir = mkdtempSync(join(tmpdir(), "analyze-no-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "bg.js"), 'chrome.offscreen.createDocument({ url: "o.html", reasons: ["DOM_PARSER"], justification: "x" });\nfetch("chrome://favicon/https://a.example");\n');
  return dir;
}

const shimmed = (issues) => issues.filter((i) => i.shimmed);

test("the default build reports the emulated features as shimmed", (t) => {
  const issues = [...analyzeManifest(manifest, { minFirefox: MIN }).issues, ...scanExtension(source(t), manifest, { minFirefox: MIN })];
  assert.ok(shimmed(issues).length >= 4, JSON.stringify(issues, null, 1));
});

test("without the shim and the bridge nothing is reported as shimmed, and each lost feature warns", (t) => {
  const manifestIssues = analyzeManifest(manifest, { minFirefox: MIN, shim: false, oauthBridge: false }).issues;
  const scanIssues = scanExtension(source(t), manifest, { minFirefox: MIN, shim: false });
  const issues = [...manifestIssues, ...scanIssues];
  assert.deepEqual(shimmed(issues), []);
  for (const i of issues) assert.doesNotMatch(`${i.message} ${i.fix ?? ""}`, /the shim (keeps|serves|drops|runs)|page bridge relays|is emulated/, i.message);
  assert.equal(manifestIssues.find((i) => /"offscreen"/.test(i.message))?.severity, "warning");
  assert.equal(manifestIssues.find((i) => /externally_connectable/.test(i.message))?.severity, "warning");
  assert.equal(scanIssues.find((i) => /offscreen/.test(i.message))?.severity, "warning");
  assert.equal(scanIssues.find((i) => /favicon/i.test(i.message))?.severity, "warning");
});

test("--analyze --json --no-shim counts nothing as shimmed", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const withShim = JSON.parse(runCli([ext, "--analyze", "--json"], { state: tempDir(t) }).stdout);
  assert.ok(withShim.shimmed > 0);
  const res = runCli([ext, "--analyze", "--json", "--no-shim"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).shimmed, 0);
});
