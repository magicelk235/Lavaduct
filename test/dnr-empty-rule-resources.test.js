// Chrome accepts declarative_net_request.rule_resources: [] from an extension
// that only adds rules at runtime. Firefox's schema wants at least one ruleset
// there and refuses the whole manifest otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = (ruleResources) => ({
  manifest_version: 3,
  name: "Dynamic rules",
  version: "1.0",
  permissions: ["declarativeNetRequest"],
  declarative_net_request: { rule_resources: ruleResources },
});

test("an empty rule_resources goes with its key; a declared ruleset stays", () => {
  const out = transformManifest(manifest([]), [], options);
  assert.equal("declarative_net_request" in out, false);
  assert.deepEqual(out.permissions, ["declarativeNetRequest"]);

  const ruleset = { id: "main", enabled: true, path: "rules.json" };
  assert.deepEqual(transformManifest(manifest([ruleset]), [], options).declarative_net_request, { rule_resources: [ruleset] });
});

test("Firefox loads the transformed manifest", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  assert.equal(await firefoxRefusal(transformManifest(manifest([]), [], options)), null);
});
