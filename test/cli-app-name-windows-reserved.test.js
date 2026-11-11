import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

function appName(t, name) {
  const ext = writeFiles(tempDir(t), sampleExtension({ "manifest.json": { manifest_version: 3, name, version: "1.0" } }));
  const res = runCli([ext, "--analyze", "--json"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout).appName;
}

// Windows keeps CON, PRN, AUX, NUL, COM1-9 and LPT1-9 for devices, with any
// extension: an add-on named "Con" would be packed into the console as Con.xpi.
test("an extension named like a Windows device gets an output name Windows can write", (t) => {
  for (const name of ["Con", "aux", "N.U.L", "COM1", "lpt9"]) {
    const derived = appName(t, name);
    assert.doesNotMatch(derived, /^(con|prn|aux|nul|com\d|lpt\d)$/i, `${name} → ${derived}`);
  }
  assert.equal(appName(t, "Console"), "Console");
  assert.equal(appName(t, "COM10"), "COM10");
});
