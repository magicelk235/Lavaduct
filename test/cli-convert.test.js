import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { ADDON_ID_SUFFIX } from "../dist/name.js";
import { SHIM_FILENAME } from "../dist/runtime/shim.js";
import { readZipEntry } from "../dist/zip/read.js";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

function outputs(dir, ext) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f)) : [];
}

function packedManifest(xpi) {
  return JSON.parse(readZipEntry(readFileSync(xpi), "manifest.json").toString("utf-8"));
}

test("an offline conversion writes an .xpi Firefox can load as an event page", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const out = join(tempDir(t), "out");
  const res = runCli([ext, "--sign", "unsigned", "--no-launch", "-o", out], { state: tempDir(t) });

  assert.equal(res.code, 0, res.stderr);
  const phases = ["› Extracting ", '✓ Loaded "Fixture Panel" (MV3)', "› Staging clean", "› Packing .xpi"];
  const at = phases.map((p) => res.stderr.indexOf(p));
  assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])), `phases out of order:\n${res.stderr}`);

  const xpis = outputs(out, ".xpi");
  assert.equal(xpis.length, 1);
  const manifest = packedManifest(xpis[0]);
  const gecko = manifest.browser_specific_settings.gecko;
  assert.ok(gecko.id.endsWith(`@${ADDON_ID_SUFFIX}`), gecko.id);
  assert.equal(gecko.strict_min_version, DEFAULT_MIN_FIREFOX);
  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, "lib.js", "sw.js"] });
  assert.equal(manifest.sidebar_action.default_panel, "panel.html");
  assert.equal(manifest.sidebar_action.open_at_install, false);
  assert.deepEqual(manifest.content_scripts[0].js, [SHIM_FILENAME, "content.js"]);
  assert.ok(readZipEntry(readFileSync(xpis[0]), SHIM_FILENAME), "the shim is packed");
  // The staged copy stays next to the .xpi, for temporary loading.
  assert.ok(existsSync(join(out, "staged_extension", "manifest.json")));
});

test("converting the same input twice packs identical bytes under the same add-on ID", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const state = tempDir(t);
  const [first, second] = ["one", "two"].map((name) => {
    const out = join(tempDir(t), name);
    const res = runCli([ext, "--no-launch", "-o", out], { state });
    assert.equal(res.code, 0, res.stderr);
    return readFileSync(outputs(out, ".xpi")[0]);
  });
  assert.ok(first.equals(second), "the packed add-on changed between runs");
});

test("a blocking error stops the conversion unless --force is given", (t) => {
  const ext = writeFiles(
    tempDir(t),
    sampleExtension({
      "manifest.json": {
        manifest_version: 3,
        name: "Broken",
        version: "1.0",
        content_scripts: [{ matches: ["https://example.com/*"], js: ["missing.js"] }],
      },
    }),
  );
  const state = tempDir(t);
  const blocked = join(tempDir(t), "blocked");
  const res = runCli([ext, "--no-launch", "-o", blocked], { state });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /✗ \d+ blocking error\(s\)\. Re-run with --force to convert anyway\./);
  assert.deepEqual(outputs(blocked, ".xpi"), []);

  const forced = join(tempDir(t), "forced");
  const again = runCli([ext, "--no-launch", "--force", "-o", forced], { state });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(outputs(forced, ".xpi").length, 1);
});

test("--zip also writes the unsigned add-on as a .zip", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const out = join(tempDir(t), "out");
  const res = runCli([ext, "--no-launch", "--zip", "-o", out], { state: tempDir(t) });

  assert.equal(res.code, 0, res.stderr);
  const [zip] = outputs(out, ".zip");
  assert.ok(zip, "no .zip written");
  assert.deepEqual(readFileSync(zip), readFileSync(outputs(out, ".xpi")[0]));
});

test("--addon-id and --addon-version end up in the packed manifest", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const out = join(tempDir(t), "out");
  const res = runCli([ext, "--no-launch", "--addon-id", "panel@example.com", "--addon-version", "1.2.3.4", "-o", out], {
    state: tempDir(t),
  });

  assert.equal(res.code, 0, res.stderr);
  const manifest = packedManifest(outputs(out, ".xpi")[0]);
  assert.equal(manifest.browser_specific_settings.gecko.id, "panel@example.com");
  assert.equal(manifest.version, "1.2.3.4");
});

test("an add-on ID AMO wouldn't accept is refused before converting", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const out = join(tempDir(t), "out");
  const res = runCli([ext, "--no-launch", "--addon-id", "not an id", "-o", out], { state: tempDir(t) });

  assert.equal(res.code, 2);
  assert.match(res.stderr, /--addon-id/);
  assert.equal(existsSync(out), false);
});
