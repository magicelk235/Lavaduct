import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageExtension } from "../dist/input/stage.js";

// A directory input can itself be a symlink (dist -> build/out, bazel-bin). Staging
// must copy the tree it points at, never reproduce the link (or fail on it).
test("a symlinked source folder is staged as a real copy of its tree", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, () => {
  const base = mkdtempSync(join(tmpdir(), "stage-symlinked-src-"));
  mkdirSync(join(base, "real", "js"), { recursive: true });
  writeFileSync(join(base, "real", "manifest.json"), "{}");
  writeFileSync(join(base, "real", "js", "bg.js"), "bg");
  writeFileSync(join(base, "real", "README.md"), "x");
  symlinkSync(join(base, "real"), join(base, "dist"), "dir");

  const stage = join(base, "out", "stage");
  assert.deepEqual(stageExtension(join(base, "dist"), stage, new Set(["js/bg.js"])), []);
  assert.equal(lstatSync(stage).isSymbolicLink(), false);
  assert.equal(readFileSync(join(stage, "js", "bg.js"), "utf-8"), "bg");
  assert.ok(existsSync(join(stage, "manifest.json")));
  assert.ok(!existsSync(join(stage, "README.md")), "exclusions still apply");
});
