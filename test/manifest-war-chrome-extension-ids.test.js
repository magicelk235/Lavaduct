// web_accessible_resources extension_ids takes Chrome's 32-letter extension IDs.
// Firefox's schema only takes add-on IDs (a GUID or name@domain) or "*", and
// refuses the whole manifest over anything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = () => ({
  manifest_version: 3,
  name: "Shared",
  version: "1.0",
  web_accessible_resources: [
    { resources: ["a/*"], extension_ids: [CHROME_ID] },
    { resources: ["b/*"], matches: ["https://example.com/*"], extension_ids: [CHROME_ID] },
    { resources: ["c/*"], extension_ids: ["*"] },
    { resources: ["d/*"], extension_ids: [CHROME_ID, "helper@example.com"] },
  ],
});

test("Chrome extension IDs are removed, and an entry left matching nothing goes", () => {
  assert.deepEqual(transformManifest(manifest(), [], options).web_accessible_resources, [
    { resources: ["b/*"], matches: ["https://example.com/*"] },
    { resources: ["c/*"], extension_ids: ["*"] },
    { resources: ["d/*"], extension_ids: ["helper@example.com"] },
  ]);
});

test("the analyzer names the Chrome IDs it removes", () => {
  const { issues } = analyzeManifest(manifest(), { minFirefox: DEFAULT_MIN_FIREFOX });
  const [issue] = issues.filter((i) => i.message.includes("extension_ids"));
  assert.ok(issue.message.includes(CHROME_ID));
  assert.equal(issue.autoFixed, true);
});

test("Firefox loads the transformed manifest", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  assert.equal(await firefoxRefusal(transformManifest(manifest(), [], options)), null);
});
