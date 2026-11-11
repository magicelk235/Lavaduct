import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeShim } from "../dist/runtime/shim.js";
import { buildShim, fakeBrowser, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// Chrome's extension ID is the host of its own origin, so code names it in a
// rule to mean its own requests: HARPA removes X-Frame-Options from harpa.ai
// frames with initiatorDomains: [chrome.runtime.id]. Firefox's add-on ID isn't
// a domain, and it refuses the whole updateSessionRules call over it ("Invalid
// domain"); its pages' host is the per-install UUID instead.

const OWN_HOST = new URL(EXT_ORIGIN).host;

function rulesAfter(script, config = {}) {
  const calls = [];
  const browser = fakeBrowser({ extra: { declarativeNetRequest: { updateSessionRules: (o) => { calls.push(o); return Promise.resolve(); } } } });
  const ctx = runInContext(buildShim(config), { browser });
  vm.runInContext(script, ctx);
  return plain(calls[0]).addRules;
}

test("the add-on's own ID in a rule's domains becomes its pages' host", () => {
  const [rule] = rulesAfter(
    "chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 1, action: { type: 'block' }, condition: { initiatorDomains: [chrome.runtime.id, 'example.com'], excludedInitiatorDomains: [chrome.runtime.id.toUpperCase()], requestDomains: ['a.org'] } }] })",
  );
  assert.deepEqual(rule.condition.initiatorDomains, [OWN_HOST, "example.com"]);
  assert.deepEqual(rule.condition.excludedInitiatorDomains, [OWN_HOST]);
  assert.deepEqual(rule.condition.requestDomains, ["a.org"]);
});

test("so does its Chrome ID written into the code", () => {
  const chromeId = "eanggfilgoajaocelnaflolkadkeghjp";
  const [rule] = rulesAfter(`chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 1, action: { type: 'block' }, condition: { initiatorDomains: ['${chromeId}'] } }] })`, { extensionId: chromeId });
  assert.deepEqual(rule.condition.initiatorDomains, [OWN_HOST]);
});

test("Firefox takes the rule, and it blocks the add-on's own requests", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  const seen = [];
  let report;
  const reported = new Promise((resolve) => (report = resolve));
  const server = http.createServer((req, res) => {
    seen.push(req.url.split("?")[0]);
    res.writeHead(200, { "access-control-allow-origin": "*" });
    res.end("ok");
    if (req.url.startsWith("/report")) report(decodeURIComponent(req.url.slice("/report?".length)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "own-id-"));
  const shim = readFileSync(join(dir, writeShim(dir, {})), "utf-8");
  rmSync(dir, { recursive: true, force: true });
  const manifest = {
    manifest_version: 3,
    name: "own id",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "own-id.0123abcd@lavaduct" } },
    permissions: ["declarativeNetRequestWithHostAccess"],
    host_permissions: ["<all_urls>"],
    background: { scripts: ["shim.js", "bg.js"] },
  };
  // Firefox refuses bad arguments synchronously, so the call starts inside then().
  const bg = `const send = (r) => fetch(${JSON.stringify(base)} + "/report?" + encodeURIComponent(r));
Promise.resolve()
  .then(() => chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 1, priority: 1, action: { type: "block" }, condition: { initiatorDomains: [chrome.runtime.id], urlFilter: "/target", resourceTypes: ["xmlhttprequest"] } }] }))
  .then(() => fetch(${JSON.stringify(base)} + "/target").then(() => "fetched", () => "blocked"))
  .then((outcome) => chrome.declarativeNetRequest.getSessionRules().then((rules) => send(JSON.stringify({ outcome, domains: rules[0].condition.initiatorDomains, host: location.host }))))
  .catch((e) => send("refused: " + e.message));`;
  const result = await loadAddon(manifest, { "shim.js": shim, "bg.js": bg }, () => Promise.race([reported, new Promise((r) => setTimeout(r, 30_000, "no report"))]));
  assert.ok(!result.startsWith("refused"), result);
  const r = JSON.parse(result);
  assert.deepEqual(r.domains, [r.host]);
  assert.equal(r.outcome, "blocked");
  assert.ok(!seen.includes("/target"), seen.join(","));
});
