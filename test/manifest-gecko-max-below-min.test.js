// The conversion forces gecko.strict_min_version but kept the author's
// strict_max_version. A max below that minimum is a range no Firefox is in, and
// Firefox refuses the add-on: "is not compatible with application version.
// add-on minVersion: 153.0. add-on maxVersion: 140.*."
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";
import { compareFirefoxVersions } from "../dist/manifest/compat-data.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = (max) => ({
  manifest_version: 3,
  name: "Capped",
  version: "1.0",
  browser_specific_settings: { gecko: { id: "theirs@example.com", strict_min_version: "109.0", strict_max_version: max } },
});

test("a strict_max_version below the forced minimum is removed, and the report says so", () => {
  const before = manifest("140.*");
  const after = transformManifest(before, [], options);
  assert.deepEqual(after.browser_specific_settings.gecko, { id: ID, strict_min_version: DEFAULT_MIN_FIREFOX });
  assert.ok(summarizeManifestChanges(before, after).some((c) => /strict_max_version.*140\.\*/.test(c)), "the change isn't reported");
});

test("a strict_max_version at or above the minimum is kept, a trailing * counting as every release", () => {
  const major = DEFAULT_MIN_FIREFOX.split(".")[0];
  for (const max of [`${major}.*`, DEFAULT_MIN_FIREFOX, "200.*"]) {
    assert.equal(transformManifest(manifest(max), [], options).browser_specific_settings.gecko.strict_max_version, max);
  }
  assert.ok(compareFirefoxVersions(`${major}.*`, `${major}.5`) > 0);
});

test("Firefox loads the transformed manifest", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  assert.equal(await firefoxRefusal(transformManifest(manifest("140.*"), [], options)), null);
});
