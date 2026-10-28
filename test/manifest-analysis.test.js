import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";

const analyze = (m, minFirefox = DEFAULT_MIN_FIREFOX) => analyzeManifest({ manifest_version: 3, name: "X", version: "1.0", description: "d", icons: { 128: "i.png" }, ...m }, { minFirefox });
const find = (issues, text) => issues.filter((i) => i.message.includes(text));

test("a permission Firefox lacks is removed with a warning, a shimmed one is only noted", () => {
  const { issues, permissionsToRemove } = analyze({ permissions: ["tabs", "pageCapture", "offscreen", "debugger"] });
  assert.deepEqual(permissionsToRemove.sort(), ["debugger", "offscreen", "pageCapture"]);

  const [lost] = find(issues, '"pageCapture"');
  assert.equal(lost.severity, "warning");
  assert.equal(lost.autoFixed, true);
  assert.ok(!lost.shimmed);

  for (const perm of ["offscreen", "debugger"]) {
    const [issue] = find(issues, `"${perm}"`);
    assert.equal(issue.severity, "info", perm);
    assert.equal(issue.shimmed, true, perm);
  }
  // The note says what the emulation can't do, so a user knows what to re-test.
  assert.match(find(issues, '"debugger"')[0].fix, /isTrusted/);

  assert.equal(find(issues, '"tabs"').length, 0);
});

test("a permission newer than --min-firefox is kept but reported", () => {
  const old = analyze({ permissions: ["tabGroups"] }, "128.0");
  assert.deepEqual(old.permissionsToRemove, []);
  const [issue] = find(old.issues, '"tabGroups"');
  assert.equal(issue.severity, "warning");
  assert.match(issue.message, /139/);

  assert.equal(find(analyze({ permissions: ["tabGroups"] }).issues, '"tabGroups"').length, 0);
});

test("optional permissions Firefox only grants at install are reported as moved", () => {
  const { issues, permissionsToRemove } = analyze({ optional_permissions: ["contextMenus"] });
  assert.deepEqual(permissionsToRemove, []);
  const [issue] = find(issues, '"contextMenus"');
  assert.equal(issue.autoFixed, true);
  assert.match(issue.message, /permissions/);
});

test("world MAIN is flagged only when the minimum Firefox predates it", () => {
  const m = { content_scripts: [{ matches: ["<all_urls>"], js: ["page.js"], world: "MAIN" }] };
  assert.equal(find(analyze(m, "115.0").issues, 'world: "MAIN"').length, 1);
  assert.equal(find(analyze(m).issues, 'world: "MAIN"').length, 0);
});

test("MV3 host permissions are flagged only when Firefox wouldn't grant them at install", () => {
  const m = { host_permissions: ["https://example.com/*"] };
  assert.equal(find(analyze(m, "120.0").issues, "host_permissions").length, 1);
  assert.equal(find(analyze(m).issues, "host_permissions").length, 0);
});

test("sandboxed pages are flagged on Firefox releases without the sandbox key", () => {
  const m = { sandbox: { pages: ["eval.html"] } };
  assert.equal(find(analyze(m).issues, "sandbox").length, 1, "153 predates sandbox support");
  assert.equal(find(analyze(m, "154.0").issues, "sandbox").length, 0);
});

test("incognito split is reported as removed", () => {
  const [issue] = find(analyze({ incognito: "split" }).issues, "split");
  assert.equal(issue.severity, "warning");
  assert.equal(issue.autoFixed, true);
});

test("a content-script pattern Firefox can't parse blocks the conversion", () => {
  const { issues } = analyze({ content_scripts: [{ matches: ["chrome://newtab/*"], js: ["a.js"] }] });
  const [issue] = find(issues, "chrome://newtab/*");
  assert.equal(issue.severity, "error");
  assert.ok(!issue.autoFixed);
});

test("a pattern with a port is called out, since Firefox never matches it", () => {
  const { issues } = analyze({ content_scripts: [{ matches: ["http://localhost:3000/*"], js: ["a.js"] }] });
  const [issue] = find(issues, "localhost:3000");
  assert.equal(issue.severity, "warning");
});

test("ws:// host permissions are valid in Firefox", () => {
  const { issues } = analyze({ host_permissions: ["wss://relay.example.com/*", "ws://*/*"] });
  assert.equal(issues.filter((i) => i.category === "permission").length, 0);
});

test("a version Firefox can't sign is reported with its replacement", () => {
  const [issue] = find(analyze({ version: "2.0-rc1" }).issues, "2.0-rc1");
  assert.match(issue.message, /"2\.0"/);
  assert.equal(issue.autoFixed, true);
});

test("externally_connectable from any extension needs no warning; named IDs do", () => {
  assert.equal(analyze({ externally_connectable: { ids: ["*"] } }).issues.filter((i) => i.severity === "warning").length, 0);
  const { issues } = analyze({ externally_connectable: { ids: ["abcdefghijklmnopabcdefghijklmnop"] } });
  assert.equal(issues.filter((i) => i.severity === "warning" && i.message.includes("externally_connectable")).length, 1);
});
