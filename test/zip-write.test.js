import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { zipDirectory } from "../dist/zip/write.js";
import { extractZip, listZip } from "../dist/zip/read.js";

function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), "zip-write-src-"));
  mkdirSync(join(dir, "js/lib"), { recursive: true });
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "T", version: "1" }));
  writeFileSync(join(dir, "js/bg.js"), "chrome.runtime.onInstalled.addListener(() => {});\n".repeat(50));
  writeFileSync(join(dir, "js/lib/ü.js"), "export const x = 1;\n");
  // Incompressible bytes: stored, not deflated.
  writeFileSync(join(dir, "noise.bin"), randomBytes(4096));
  return dir;
}

test("packing the same tree twice gives identical bytes, regardless of mtimes", () => {
  const dir = makeTree();
  const out = mkdtempSync(join(tmpdir(), "zip-write-out-"));
  zipDirectory(dir, join(out, "a.xpi"));
  utimesSync(join(dir, "js/bg.js"), new Date(2001, 1, 1), new Date(2001, 1, 1));
  zipDirectory(dir, join(out, "b.xpi"));
  assert.ok(readFileSync(join(out, "a.xpi")).equals(readFileSync(join(out, "b.xpi"))));
});

test("a packed tree round-trips through extractZip", () => {
  const dir = makeTree();
  const out = join(mkdtempSync(join(tmpdir(), "zip-write-out-")), "x.xpi");
  zipDirectory(dir, out);
  const buf = readFileSync(out);
  assert.deepEqual(
    listZip(buf).map((e) => e.name),
    ["js/bg.js", "js/lib/ü.js", "manifest.json", "noise.bin"],
  );
  const dest = mkdtempSync(join(tmpdir(), "zip-write-x-"));
  extractZip(buf, dest);
  for (const rel of ["manifest.json", "js/bg.js", "js/lib/ü.js", "noise.bin"]) {
    assert.ok(readFileSync(join(dest, rel)).equals(readFileSync(join(dir, rel))), rel);
  }
  // No directory entries, so an empty source dir doesn't come back.
  assert.deepEqual(readdirSync(dest).sort(), ["js", "manifest.json", "noise.bin"]);
});

test("symlinks in the tree are left out of the archive", () => {
  const dir = makeTree();
  symlinkSync("/etc/hosts", join(dir, "hosts"));
  const out = join(mkdtempSync(join(tmpdir(), "zip-write-out-")), "x.xpi");
  zipDirectory(dir, out);
  assert.ok(!listZip(readFileSync(out)).some((e) => e.name === "hosts"));
});

test("an output path inside the source tree isn't packed into itself", () => {
  const dir = makeTree();
  const out = join(dir, "self.xpi");
  zipDirectory(dir, out);
  zipDirectory(dir, out);
  assert.ok(!listZip(readFileSync(out)).some((e) => e.name === "self.xpi"));
});
