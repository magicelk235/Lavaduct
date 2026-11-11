// Chrome accepts a web_accessible_resources entry whose only key besides
// resources is use_dynamic_url. With that key removed, the entry has neither
// matches nor extension_ids, and Firefox refuses the whole manifest over it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = () => ({
  manifest_version: 3,
  name: "Dynamic",
  version: "1.0",
  web_accessible_resources: [
    { resources: ["private/*"], use_dynamic_url: true },
    { resources: ["public/*"], matches: ["<all_urls>"], use_dynamic_url: true },
  ],
});

test("an entry left with neither matches nor extension_ids is dropped", () => {
  assert.deepEqual(transformManifest(manifest(), [], options).web_accessible_resources, [
    { resources: ["public/*"], matches: ["<all_urls>"] },
  ]);
});

test("the analyzer says the entry goes", () => {
  const { issues } = analyzeManifest(manifest(), { minFirefox: DEFAULT_MIN_FIREFOX });
  const [issue] = issues.filter((i) => i.message.includes("use_dynamic_url"));
  assert.match(issue.message, /neither matches nor extension_ids/);
});

test("Firefox loads the transformed manifest", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  assert.equal(await firefoxRefusal(transformManifest(manifest(), [], options)), null);
});
