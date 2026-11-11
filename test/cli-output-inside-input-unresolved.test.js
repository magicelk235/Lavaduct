import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

// The overlap guard compares real paths, and an output directory that doesn't
// exist yet has none: reached through a symlink, it must still count as inside.
test("an output directory not created yet, inside the input through a symlink, is refused", (t) => {
  const root = tempDir(t);
  const ext = writeFiles(join(root, "ext"), sampleExtension());
  const link = join(root, "link");
  try {
    symlinkSync(ext, link, "dir");
  } catch (e) {
    t.skip(`can't create a symlink here: ${e.code}`);
    return;
  }
  const res = runCli([ext, "--no-launch", "-o", join(link, "out")], { state: tempDir(t) });

  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /^✗ Output directory .* is inside the input extension/m);
  assert.ok(!existsSync(join(ext, "out")), "the run wrote into the input extension");
});

test("a fresh output directory in the input's parent, through a symlink, still converts", (t) => {
  const root = tempDir(t);
  const ext = writeFiles(join(root, "exts", "ext"), sampleExtension());
  const link = join(root, "link");
  mkdirSync(join(root, "exts"), { recursive: true });
  try {
    symlinkSync(join(root, "exts"), link, "dir");
  } catch (e) {
    t.skip(`can't create a symlink here: ${e.code}`);
    return;
  }
  const res = runCli([ext, "--no-launch", "-o", join(link, "ext-out", "deeper")], { state: tempDir(t) });

  assert.equal(res.code, 0, res.stderr);
  assert.ok(existsSync(join(root, "exts", "ext-out", "deeper", "staged_extension", "manifest.json")));
});

test("an output directory not created yet, inside the input under another case, is refused", (t) => {
  const root = tempDir(t);
  const ext = writeFiles(join(root, "Ext"), sampleExtension());
  if (!existsSync(join(root, "EXT"))) {
    t.skip("the file system here is case-sensitive");
    return;
  }
  const res = runCli([ext, "--no-launch", "-o", join(root, "ext", "out")], { state: tempDir(t) });

  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /^✗ Output directory .* is inside the input extension/m);
  assert.ok(!existsSync(join(ext, "out")), "the run wrote into the input extension");
});
