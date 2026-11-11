// Chrome lower-cases the domains in a DNR rule's domain conditions. Firefox wants
// them already canonical and drops a static rule with "Example.com" without a word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDnr } from "../dist/manifest/dnr.js";
import { firefox, loadAddon } from "./firefox-load.js";

const rules = () => [
  { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "ads", requestDomains: ["Example.com"], excludedInitiatorDomains: ["Safe.EXAMPLE.org"] } },
  { id: 2, priority: 1, action: { type: "block" }, condition: { urlFilter: "track", initiatorDomains: ["example.net"] } },
];
const manifest = () => ({
  manifest_version: 3,
  name: "Blocker",
  version: "1.0",
  browser_specific_settings: { gecko: { id: "dnr-case@example.com" } },
  permissions: ["declarativeNetRequest"],
  declarative_net_request: { rule_resources: [{ id: "main", enabled: true, path: "rules.json" }] },
});

function convertRules() {
  const dir = mkdtempSync(join(tmpdir(), "lavaduct-dnr-"));
  try {
    writeFileSync(join(dir, "rules.json"), JSON.stringify(rules()));
    applyDnr(dir, manifest());
    return JSON.parse(readFileSync(join(dir, "rules.json"), "utf-8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("domains in rule conditions are lower-cased", () => {
  const [first, second] = convertRules();
  assert.deepEqual(first.condition.requestDomains, ["example.com"]);
  assert.deepEqual(first.condition.excludedInitiatorDomains, ["safe.example.org"]);
  assert.deepEqual(second, rules()[1]);
});

test("Firefox loads every rule of the converted ruleset", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  const loaded = await loadAddon(manifest(), { "rules.json": JSON.stringify(convertRules()) }, ({ chrome, id }) =>
    chrome(`(async () => {
      const { ExtensionDNR } = ChromeUtils.importESModule("resource://gre/modules/ExtensionDNR.sys.mjs");
      const extension = WebExtensionPolicy.getByID(${JSON.stringify(id)}).extension;
      await ExtensionDNR.ensureInitialized(extension);
      return ExtensionDNR.getRuleManager(extension).getRulesCount();
    })()`),
  );
  assert.equal(loaded, 2);
});
