import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zipDirectory } from "../dist/zip/write.js";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

// "Fixture Panel" becomes FixturePanel.xpi / FixturePanel.zip in the output directory.
function archiveIn(t, out, name) {
  const ext = writeFiles(tempDir(t), sampleExtension());
  mkdirSync(out, { recursive: true });
  const archive = join(out, name);
  zipDirectory(ext, archive);
  return { archive, bytes: readFileSync(archive) };
}

for (const [name, flags] of [
  ["FixturePanel.zip", ["--zip"]],
  ["FixturePanel.xpi", []],
]) {
  test(`an input archive at the output's ${name} is refused, not overwritten`, (t) => {
    const out = join(tempDir(t), "out");
    const { archive, bytes } = archiveIn(t, out, name);
    const res = runCli([archive, "--no-launch", "-o", out, ...flags], { state: tempDir(t) });

    assert.equal(res.code, 1, res.stderr);
    assert.match(res.stderr, /^✗ .*overwrite/m);
    assert.ok(readFileSync(archive).equals(bytes), "the input archive was overwritten");
    assert.ok(!existsSync(join(out, "staged_extension")), "nothing is written for a refused run");
  });
}

test("--clean refuses an output directory that holds the input archive", (t) => {
  const out = join(tempDir(t), "out");
  const { archive, bytes } = archiveIn(t, out, "source.zip");
  const res = runCli([archive, "--no-launch", "--clean", "-o", out], { state: tempDir(t) });

  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /^✗ .*--clean/m);
  assert.ok(existsSync(archive) && readFileSync(archive).equals(bytes), "--clean deleted the input archive");
});

test("an input archive beside the output files still converts", (t) => {
  const out = join(tempDir(t), "out");
  const { archive, bytes } = archiveIn(t, out, "source.zip");
  const res = runCli([archive, "--no-launch", "--zip", "-o", out], { state: tempDir(t) });

  assert.equal(res.code, 0, res.stderr);
  assert.ok(existsSync(join(out, "staged_extension", "manifest.json")));
  assert.ok(readFileSync(archive).equals(bytes));
});
