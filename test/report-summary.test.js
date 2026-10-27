import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countBlocking, summarizeManifestChanges, writeReportFile } from "../dist/analyze/report.js";

const issues = [
  { severity: "error", category: "manifest", message: "missing file" },
  { severity: "error", category: "icons", message: "fixed icon", autoFixed: true },
  { severity: "warning", category: "api", message: "a warning" },
  { severity: "warning", category: "api", message: "another warning" },
  { severity: "info", category: "api", message: "shimmed", shimmed: true },
];

test("countBlocking counts warnings only under --strict, never auto-fixed issues", () => {
  assert.equal(countBlocking(issues), 1);
  assert.equal(countBlocking(issues, true), 3);
});

test("the report status agrees with the strict blocking count", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const meta = { name: "Ext", version: "1.0", manifestVersion: 3, platforms: "desktop", strict: true };
  const md = readFileSync(writeReportFile(dir, meta, issues), "utf-8");
  assert.match(md, /- Status: 3 blocking issue\(s\) \(--strict: warnings count as blocking\)/);
  assert.match(md, /- Platforms: desktop/);
});

test("manifest change summary reports the gecko block and Firefox mappings", () => {
  const before = {
    manifest_version: 3,
    name: "Panel",
    version: "1.0.0.0.1",
    key: "MIIB",
    update_url: "https://clients2.google.com/service/update2/crx",
    incognito: "split",
    side_panel: { default_path: "panel.html" },
    background: { service_worker: "sw.js", type: "module" },
    web_accessible_resources: [{ resources: ["x.png"], matches: ["<all_urls>"], use_dynamic_url: true }],
  };
  const after = {
    manifest_version: 3,
    name: "Panel",
    version: "1.0.0.0",
    sidebar_action: { default_panel: "panel.html", default_title: "Panel", open_at_install: false },
    background: { scripts: ["sw.js"], type: "module" },
    web_accessible_resources: [{ resources: ["x.png"], matches: ["<all_urls>"] }],
    browser_specific_settings: {
      gecko: { id: "abc.1234abcd@example", strict_min_version: "153.0" },
      gecko_android: {},
    },
  };
  const lines = summarizeManifestChanges(before, after);
  const has = (re) => assert.ok(lines.some((l) => re.test(l)), `${re} not in:\n${lines.join("\n")}`);
  has(/Dropped `key`/);
  has(/Dropped `update_url`/);
  has(/`1\.0\.0\.0\.1` → `1\.0\.0\.0` \(Firefox format\)/);
  has(/browser_specific_settings\.gecko`: id `abc\.1234abcd@example`, strict_min_version `153\.0`/);
  has(/gecko_android/);
  has(/`side_panel` to `sidebar_action` → `panel\.html`/);
  has(/incognito: "split"/);
  has(/use_dynamic_url/);
  has(/service_worker` into `background\.scripts`/);
  assert.ok(!lines.some((l) => /safari/i.test(l)));
});

test("an unchanged gecko block is not reported", () => {
  const m = {
    manifest_version: 3,
    name: "Same",
    version: "1",
    browser_specific_settings: { gecko: { id: "a@b", strict_min_version: "153.0" } },
  };
  assert.deepEqual(summarizeManifestChanges(m, structuredClone(m)), []);
});
