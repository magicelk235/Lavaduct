// A manifest without a version is packed as 0.0.0; the report used to print the
// change as "Version `undefined` → `0.0.0`".
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";

test("a missing version is named as missing in the manifest changes", () => {
  const before = { manifest_version: 3, name: "No version" };
  const after = transformManifest(before, [], { addonId: "x@lavaduct", minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "0.0.0" });
  const [line] = summarizeManifestChanges(before, after).filter((c) => c.startsWith("Version"));
  assert.equal(line, "Version (none) → `0.0.0` (Firefox format).");
});
