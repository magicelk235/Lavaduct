import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

function stagedVersion(dir) {
  return JSON.parse(readFileSync(join(dir, "staged_extension", "manifest.json"), "utf-8")).version;
}

// Two versions of one extension, or two names that strip to the same folder
// name, must not land in one ./<Name>_Firefox where the second replaces the first.
test("batch inputs whose names map to the same folder each keep their own output", (t) => {
  const manifest = (name, version) => ({ "manifest.json": { manifest_version: 3, name, version } });
  const first = writeFiles(tempDir(t), sampleExtension(manifest("Same Name", "1.0")));
  const second = writeFiles(tempDir(t), sampleExtension(manifest("Same-Name!", "2.0")));
  const third = writeFiles(tempDir(t), sampleExtension(manifest("SameName", "3.0")));
  const cwd = tempDir(t);
  const res = runCli([first, second, third, "--no-launch"], { cwd, state: tempDir(t) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(stagedVersion(join(cwd, "SameName_Firefox")), "1.0");
  assert.equal(stagedVersion(join(cwd, "Same-Name_Firefox")), "2.0");
  assert.equal(stagedVersion(join(cwd, "SameName_Firefox_2")), "3.0", res.stderr);
  assert.ok(existsSync(join(cwd, "SameName_Firefox_2", "SameName.xpi")));
  assert.match(res.stderr, /^! .*SameName_Firefox.*earlier input in this batch/m);
});
