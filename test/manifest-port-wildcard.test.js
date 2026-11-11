// Chrome's match patterns take a port wildcard (http://localhost:*/*). Firefox's
// grammar has none: it refuses a manifest whose content scripts use one and drops
// such a host permission. A Firefox pattern without a port matches every port, so
// that is the same pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { countBlocking, summarizeManifestChanges } from "../dist/analyze/report.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = () => ({
  manifest_version: 3,
  name: "Local dev",
  version: "1.0",
  host_permissions: ["http://localhost:*/*", "https://example.com/*"],
  optional_host_permissions: ["*://*.test:*/*"],
  content_scripts: [{ matches: ["http://127.0.0.1:*/*"], exclude_matches: ["http://localhost:*/admin/*"], js: ["a.js"] }],
  web_accessible_resources: [{ resources: ["a.js"], matches: ["http://localhost:*/*"] }],
});

test("a port wildcard becomes the same pattern without a port", () => {
  const out = transformManifest(manifest(), [], options);
  assert.deepEqual(out.host_permissions, ["http://localhost/*", "https://example.com/*"]);
  assert.deepEqual(out.optional_host_permissions, ["*://*.test/*"]);
  assert.deepEqual(out.content_scripts[0].matches, ["http://127.0.0.1/*"]);
  assert.deepEqual(out.content_scripts[0].exclude_matches, ["http://localhost/admin/*"]);
  assert.deepEqual(out.web_accessible_resources[0].matches, ["http://localhost/*"]);
});

test("MV2 origins among the permissions lose the port wildcard too", () => {
  const out = transformManifest({ manifest_version: 2, name: "Old", version: "1.0", permissions: ["tabs", "http://localhost:*/*"] }, [], options);
  assert.deepEqual(out.permissions, ["tabs", "http://localhost/*"]);
});

test("the conversion report calls it a rewrite, not a removal and an addition", () => {
  const before = manifest();
  const changes = summarizeManifestChanges(before, transformManifest(before, [], options));
  assert.ok(changes.some((c) => c.startsWith("Dropped the port wildcard") && c.includes("`http://localhost:*/*`")), changes.join("\n"));
  assert.ok(!changes.some((c) => c.startsWith("Removed") || c.startsWith("Added")), changes.join("\n"));
});

test("the analyzer reports the rewrite instead of blocking on it", () => {
  const { issues } = analyzeManifest(manifest(), { minFirefox: DEFAULT_MIN_FIREFOX });
  assert.equal(countBlocking(issues), 0);
  assert.equal(issues.filter((i) => i.message.includes("will be removed")).length, 0, "no host pattern is dropped");
  const [issue] = issues.filter((i) => i.message.includes("port wildcard"));
  assert.equal(issue.autoFixed, true);
  assert.ok(issue.message.includes("http://localhost:*/*"));
});

test("Firefox loads the transformed manifest", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  assert.equal(await firefoxRefusal(transformManifest(manifest(), [], options), { "a.js": "" }), null);
});
