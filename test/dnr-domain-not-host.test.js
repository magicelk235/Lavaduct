// Chrome takes any ASCII string as a rule's domain; one that is no host name just
// never matches. Firefox's canonicalDomain format wants the host name a URL makes of
// the string and drops the static rule over any other entry ("Invalid rule at index
// 0 from ruleset …: Invalid domain a@b"), only that rule, not the ruleset (measured
// in Firefox 160). The runtime-rule filter in the shim does the same with an
// identical predicate; the last test holds the two to the same answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDnr } from "../dist/manifest/dnr.js";
import { buildShim, fakeBrowser, runInContext, plain } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

const rules = () => [
  { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "ads", requestDomains: ["example.com", "abc.1f6eaaec@lavaduct*"] } },
  { id: 2, priority: 1, action: { type: "allow" }, condition: { urlFilter: "ads", excludedInitiatorDomains: ["Safe.example.org", "a/b"] } },
  { id: 3, priority: 1, action: { type: "block" }, condition: { urlFilter: "ads", requestDomains: ["x y", "142.91.159."] } },
  { id: 4, priority: 1, action: { type: "block" }, condition: { urlFilter: "track", initiatorDomains: ["example.net", "a*"] } },
];
const manifest = () => ({
  manifest_version: 3,
  name: "Blocker",
  version: "1.0",
  browser_specific_settings: { gecko: { id: "dnr-not-host@example.com" } },
  permissions: ["declarativeNetRequest"],
  declarative_net_request: { rule_resources: [{ id: "main", enabled: true, path: "rules.json" }] },
});

function convertRules(list = rules()) {
  const dir = mkdtempSync(join(tmpdir(), "lavaduct-dnr-"));
  try {
    writeFileSync(join(dir, "rules.json"), JSON.stringify(list));
    const { notes } = applyDnr(dir, manifest());
    return { rules: JSON.parse(readFileSync(join(dir, "rules.json"), "utf-8")), notes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("domains that are no host name are left out of static rules, and the notes say so", () => {
  const { rules: out, notes } = convertRules();
  assert.deepEqual(out.map((r) => r.id), [1, 2, 4], "a rule whose request domains were all no host name matches nothing in Chrome");
  assert.deepEqual(out[0].condition.requestDomains, ["example.com"]);
  assert.deepEqual(out[1].condition.excludedInitiatorDomains, ["safe.example.org"]);
  assert.deepEqual(out[2], rules()[3], "'a*' is a host name to Firefox, so the rule is untouched");
  const text = notes.map((n) => n.message).join("\n");
  assert.match(text, /removed 1 rule\(s\).*rule 3 \(only requestDomains that are no host name\)/);
  assert.match(text, /left "abc\.1f6eaaec@lavaduct\*", "a\/b" out of the domains of 2 rule\(s\)/);
});

test("Firefox loads every rule of the converted ruleset", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  const loaded = await loadAddon(manifest(), { "rules.json": JSON.stringify(convertRules().rules) }, ({ chrome, id }) =>
    chrome(`(async () => {
      const { ExtensionDNR } = ChromeUtils.importESModule("resource://gre/modules/ExtensionDNR.sys.mjs");
      const extension = WebExtensionPolicy.getByID(${JSON.stringify(id)}).extension;
      await ExtensionDNR.ensureInitialized(extension);
      return ExtensionDNR.getRuleManager(extension).getRulesCount();
    })()`),
  );
  assert.equal(loaded, 3);
});

test("static and runtime rules leave out the same domains", () => {
  // Strings Firefox 160 was measured on: it refused exactly the ones marked false.
  const samples = { "a*": true, "a@b": false, "a b": false, "a/b": false, "1.2.3": false, "142.91.159.": false, "a_b": true, "a..b": true, "-a": true, "a:80": false, "example.com.": true, "xn--bcher-kva.de": true, "%41": false, "a|b": false, "*.a.com": true, "a<b": false };
  const list = Object.keys(samples).map((d, i) => ({ id: i + 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "ads", requestDomains: ["ok.com", d] } }));
  const staticKept = convertRules(list).rules.map((r) => r.condition.requestDomains.slice(1));
  const calls = [];
  const browser = fakeBrowser({ extra: { declarativeNetRequest: { updateDynamicRules: (o) => { calls.push(o); return Promise.resolve(); } } } });
  const ctx = runInContext(buildShim({}), { browser });
  vm.runInContext(`chrome.declarativeNetRequest.updateDynamicRules({ addRules: ${JSON.stringify(list)} })`, ctx);
  const runtimeKept = plain(calls[0]).addRules.map((r) => r.condition.requestDomains.slice(1));
  assert.deepEqual(staticKept, runtimeKept);
  assert.deepEqual(staticKept.map((k) => k.length === 1), Object.values(samples));
});
