import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeShim } from "../dist/runtime/shim.js";
import { buildShim, fakeBrowser, runInContext, plain } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// Chrome takes any ASCII string as a rule's domain; one that is no host name just
// never matches. Total Adblock's allowlist rule excludes `${chrome.runtime.id}*`,
// which in Firefox reads "<id>@lavaduct*", and Firefox refuses the whole
// updateDynamicRules call over it ("Invalid domain"), losing every rule in it.

function rulesAfter(script) {
  const calls = [];
  const browser = fakeBrowser({ extra: { declarativeNetRequest: { updateDynamicRules: (o) => { calls.push(o); return Promise.resolve(); } } } });
  const ctx = runInContext(buildShim({}), { browser });
  vm.runInContext(script, ctx);
  return plain(calls[0]).addRules;
}

test("domain entries that are no host name are left out", () => {
  const rules = rulesAfter(`chrome.declarativeNetRequest.updateDynamicRules({ addRules: [
    { id: 1, action: { type: "block" }, condition: { urlFilter: "ads", excludedRequestDomains: ["example.com", chrome.runtime.id + "*"], initiatorDomains: ["a.org", "a/b"] } },
    { id: 2, action: { type: "block" }, condition: { urlFilter: "ads", requestDomains: ["x y", "c@d"] } },
    { id: 3, action: { type: "block" }, condition: { urlFilter: "ads", requestDomains: ["bücher.de"], excludedInitiatorDomains: ["q@r"] } },
  ] })`);
  assert.deepEqual(rules.map((r) => r.id), [1, 3], "a rule whose positive list matched nothing stays out");
  assert.deepEqual(rules[0].condition.excludedRequestDomains, ["example.com"]);
  assert.deepEqual(rules[0].condition.initiatorDomains, ["a.org"]);
  assert.deepEqual(rules[1].condition.requestDomains, ["bücher.de"], "non-ASCII stays: Chrome refuses it too");
  assert.deepEqual(rules[1].condition.excludedInitiatorDomains, []);
});

test("Firefox takes the call, and the rule still blocks", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
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
  const dir = mkdtempSync(join(tmpdir(), "dnr-not-host-"));
  const shim = readFileSync(join(dir, writeShim(dir, {})), "utf-8");
  rmSync(dir, { recursive: true, force: true });
  const manifest = {
    manifest_version: 3,
    name: "dnr not host",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "dnr-not-host.0123abcd@lavaduct" } },
    permissions: ["declarativeNetRequestWithHostAccess"],
    host_permissions: ["<all_urls>"],
    background: { scripts: ["shim.js", "bg.js"] },
  };
  const bg = `const send = (r) => fetch(${JSON.stringify(base)} + "/report?" + encodeURIComponent(r));
Promise.resolve()
  .then(() => chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "/target", resourceTypes: ["xmlhttprequest"], excludedRequestDomains: ["example.com", chrome.runtime.id + "*"] } }] }))
  .then(() => fetch(${JSON.stringify(base)} + "/target").then(() => "fetched", () => "blocked"))
  .then((outcome) => chrome.declarativeNetRequest.getDynamicRules().then((rules) => send(JSON.stringify({ outcome, excluded: rules[0].condition.excludedRequestDomains }))))
  .catch((e) => send("refused: " + e.message));`;
  const result = await loadAddon(manifest, { "shim.js": shim, "bg.js": bg }, () => Promise.race([reported, new Promise((r) => setTimeout(r, 30_000, "no report"))]));
  assert.ok(!result.startsWith("refused"), result);
  const r = JSON.parse(result);
  assert.deepEqual(r.excluded, ["example.com"]);
  assert.equal(r.outcome, "blocked");
  assert.ok(!seen.includes("/target"), seen.join(","));
});
