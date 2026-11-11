// What the build itself learns (DNR rules Firefox can't take, rulesets its limits
// make it ignore, manifest-referenced files staging couldn't copy) was only printed
// as a warning line during a conversion. --analyze builds with a silent logger, so
// --analyze --json, --report and CONVERSION_REPORT.md said nothing about it and an
// add-on whose rules Firefox drops came out "convertible" with no sign of the loss.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runCli, tempDir, writeFiles } from "./cli-helpers.js";

function extension(t) {
  const root = tempDir(t);
  const ext = writeFiles(join(root, "ext"), {
    "manifest.json": {
      manifest_version: 3,
      name: "Notes",
      version: "1.0",
      permissions: ["declarativeNetRequest"],
      declarative_net_request: { rule_resources: [{ id: "main", enabled: true, path: "rules.json" }] },
      content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js", "linked.js"] }],
    },
    "rules.json": [
      { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "ads", resourceTypes: ["script"] } },
      { id: 2, priority: 1, action: { type: "block" }, condition: { urlFilter: "x", responseHeaders: [{ header: "x-a" }] } },
    ],
    "content.js": "",
  });
  writeFiles(join(root, "outside"), { "linked.js": "" });
  try {
    symlinkSync(join(root, "outside", "linked.js"), join(ext, "linked.js"));
  } catch (e) {
    t.skip(`can't create a symlink here: ${e.code}`);
    return undefined;
  }
  return ext;
}

const dnrIssue = (issues) => issues.find((i) => i.category === "dnr" && /"main"/.test(i.message) && /rule 2/.test(i.message));
const stagingIssue = (issues) => issues.find((i) => i.category === "staging" && /linked\.js/.test(`${i.file} ${i.message}`));

test("--analyze --json lists the DNR rules removed and the files staging couldn't copy", (t) => {
  const ext = extension(t);
  if (!ext) return;
  const res = runCli([ext, "--analyze", "--json"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr);
  const { issues } = JSON.parse(res.stdout);
  assert.equal(dnrIssue(issues)?.severity, "warning", JSON.stringify(issues, null, 1));
  assert.equal(stagingIssue(issues)?.severity, "warning", JSON.stringify(issues, null, 1));
});

test("CONVERSION_REPORT.md carries the same notes", (t) => {
  const ext = extension(t);
  if (!ext) return;
  const out = join(tempDir(t), "out");
  const res = runCli([ext, "--no-launch", "-o", out], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr);
  const report = readFileSync(join(out, "CONVERSION_REPORT.md"), "utf-8");
  assert.match(report, /DNR ruleset "main".*rule 2/);
  assert.match(report, /linked\.js/);
});

test("--strict counts a build warning as blocking, as --analyze does", (t) => {
  const ext = extension(t);
  if (!ext) return;
  const analysis = runCli([ext, "--analyze", "--json", "--strict"], { state: tempDir(t) });
  assert.equal(analysis.code, 1);
  assert.equal(JSON.parse(analysis.stdout).convertible, false);

  const res = runCli([ext, "--no-launch", "--strict", "-o", join(tempDir(t), "out")], { state: tempDir(t) });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /blocking issue\(s\) \(--strict: warnings count\)/);
});
