import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wireBackground, workerChunkGlobal, SHIM_FILENAME } from "../dist/runtime/shim.js";

// wireBackground rewrites the worker's importScripts calls in place. A path
// from the manifest or from an importScripts literal that climbs out of the
// staged add-on ("../victim.js") must never be read as part of it, let alone
// rewritten: the conversion would edit a file of the user's outside its
// output folder.

function layout(t) {
  const root = mkdtempSync(join(tmpdir(), "bg-wire-outside-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "staged_extension");
  mkdirSync(dir);
  const victim = 'importScripts("x.js");\nvar V = 1;\n';
  writeFileSync(join(root, "victim.js"), victim);
  writeFileSync(join(root, "x.js"), "var X = 1;\n");
  return { root, dir, victim };
}

test("a service_worker path outside the staged add-on is left alone, and so is the file it names", (t) => {
  const { root, dir, victim } = layout(t);
  for (const sw of ["../victim.js", "/../victim.js", "sub/../../victim.js"]) {
    const manifest = { manifest_version: 3, background: { service_worker: sw } };
    const res = wireBackground(dir, manifest, SHIM_FILENAME);
    assert.equal(readFileSync(join(root, "victim.js"), "utf-8"), victim, `${sw}: the file outside is untouched`);
    assert.equal(res.converted, false, sw);
    assert.deepEqual(manifest.background, { service_worker: sw }, `${sw}: the manifest is left for Firefox to refuse`);
    assert.equal(workerChunkGlobal(dir, { background: { service_worker: sw } }), "");
  }
});

test("an importScripts literal that climbs out of the add-on is neutralised but never hoisted or rewritten", (t) => {
  const { root, dir, victim } = layout(t);
  writeFileSync(join(dir, "sw.js"), 'importScripts("../victim.js", "/../victim.js");\nvar S = 1;\n');
  const manifest = { manifest_version: 3, background: { service_worker: "sw.js" } };
  const res = wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(res.hoisted, []);
  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, "sw.js"] });
  assert.equal(readFileSync(join(root, "victim.js"), "utf-8"), victim, "the file outside is untouched");
  assert.doesNotMatch(readFileSync(join(dir, "sw.js"), "utf-8"), /\bimportScripts\s*\(/, "the call itself is still de-fanged");
});
