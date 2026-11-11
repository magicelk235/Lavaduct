import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

function appName(t, name) {
  const ext = writeFiles(tempDir(t), sampleExtension({ "manifest.json": { manifest_version: 3, name, version: "1.0" } }));
  const res = runCli([ext, "--analyze", "--json"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout).appName;
}

// The folder and .xpi name keep the letters of the extension's name. Vowel signs
// in Indic scripts and accents typed as combining marks are part of those letters.
test("the output name keeps combining marks, so Indic names aren't garbled", (t) => {
  assert.equal(appName(t, "हिन्दी टूल"), "हिन्दीटूल");
  assert.equal(appName(t, "ภาษาไทย"), "ภาษาไทย");
});

test("a name spelled with decomposed accents gets the same output name as the composed one", (t) => {
  assert.equal(appName(t, "Cafe\u0301 Helper"), "Caf\u00e9Helper");
});
