import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

// The report is what the user asked for; a run that couldn't write it failed.
for (const json of [false, true]) {
  test(`--analyze${json ? " --json" : ""} fails when --report can't be written`, (t) => {
    const ext = writeFiles(tempDir(t), sampleExtension());
    const report = join(tempDir(t), "no-such-dir", "report.md");
    const res = runCli([ext, "--analyze", ...(json ? ["--json"] : []), "--report", report], { state: tempDir(t) });

    assert.equal(res.code, 1, res.stderr);
    assert.match(res.stderr, /^✗ Could not write report/m);
    if (json) assert.equal(JSON.parse(res.stdout).convertible, true);
  });
}
