// Chrome accepts an empty content_scripts exclude_matches. Firefox's schema wants
// at least one pattern there and refuses the whole manifest otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = () => ({
  manifest_version: 3,
  name: "Excludes",
  version: "1.0",
  content_scripts: [
    { matches: ["https://*/*"], exclude_matches: [], js: ["a.js"] },
    { matches: ["https://*/*"], exclude_matches: ["https://example.com/*"], js: ["a.js"] },
  ],
});

test("an empty exclude_matches is removed, a non-empty one kept", () => {
  const [empty, kept] = transformManifest(manifest(), [], options).content_scripts;
  assert.equal("exclude_matches" in empty, false);
  assert.deepEqual(kept.exclude_matches, ["https://example.com/*"]);
});

test("Firefox loads the transformed manifest", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  assert.equal(await firefoxRefusal(transformManifest(manifest(), [], options), { "a.js": "" }), null);
});
