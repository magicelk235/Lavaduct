// Chrome lets declarativeNetRequest be optional. Firefox's schema only takes it in
// permissions and drops it from optional_permissions with a warning, so the
// add-on never gets chrome.declarativeNetRequest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = () => ({
  manifest_version: 3,
  name: "Blocker",
  version: "1.0",
  permissions: ["storage"],
  optional_permissions: ["declarativeNetRequest", "tabs"],
});

test("an optional declarativeNetRequest moves to permissions", () => {
  const out = transformManifest(manifest(), [], options);
  assert.deepEqual(out.permissions, ["storage", "declarativeNetRequest"]);
  assert.deepEqual(out.optional_permissions, ["tabs"]);
});

test("the analyzer says Firefox asks for it at install", () => {
  const { issues } = analyzeManifest(manifest(), { minFirefox: DEFAULT_MIN_FIREFOX });
  const [issue] = issues.filter((i) => i.message.includes('"declarativeNetRequest"'));
  assert.equal(issue.autoFixed, true);
  assert.match(issue.message, /at install/);
  assert.doesNotMatch(issue.message, /without a prompt/);
});

test("the conversion report calls it a move without promising no prompt", () => {
  const before = manifest();
  const [moved] = summarizeManifestChanges(before, transformManifest(before, [], options)).filter((c) => c.startsWith("Moved"));
  assert.ok(moved.includes("`declarativeNetRequest`"));
  assert.doesNotMatch(moved, /without a prompt/);
});
