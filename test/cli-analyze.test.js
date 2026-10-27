import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADDON_ID_SUFFIX } from "../dist/name.js";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

// The --analyze --json payload the Viaduct app reads; same keys as viaduct-cli's,
// with addonId in place of bundleId.
const REPORT_KEYS = [
  "addonId",
  "appName",
  "autoFixed",
  "blocking",
  "convertible",
  "counts",
  "issues",
  "manifestChanges",
  "manifestVersion",
  "name",
  "platforms",
  "removedPermissions",
  "shimmed",
  "version",
];

function snapshot(dir, prefix = "") {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, snapshot(path, `${prefix}${name}/`));
    else out[prefix + name] = readFileSync(path, "utf-8");
  }
  return out;
}

test("--analyze --json prints one report on stdout and previews the Firefox manifest", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const before = snapshot(ext);
  const res = runCli([ext, "--analyze", "--json"], { state: tempDir(t) });

  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(report).sort(), REPORT_KEYS);
  assert.equal(report.name, "Fixture Panel");
  assert.equal(report.version, "1.2.3");
  assert.equal(report.manifestVersion, 3);
  assert.equal(report.platforms, "desktop");
  assert.equal(report.convertible, true);
  assert.equal(report.blocking, 0);
  assert.ok(report.addonId.endsWith(`@${ADDON_ID_SUFFIX}`), report.addonId);
  assert.deepEqual(report.removedPermissions, ["sidePanel"]);
  const changes = report.manifestChanges.join("\n");
  assert.match(changes, /service_worker` into `background\.scripts`/);
  assert.match(changes, /`side_panel` to `sidebar_action`/);
  // The preview runs on a copy: an unpacked input is the user's own tree.
  assert.deepEqual(snapshot(ext), before);
});

test("--analyze --json exits 1 when an error blocks the conversion", (t) => {
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
  const res = runCli([ext, "--analyze", "--json"], { state: tempDir(t) });

  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.convertible, false);
  assert.ok(report.blocking >= 1);
  assert.ok(report.issues.some((i) => i.severity === "error" && /missing\.js/.test(`${i.file} ${i.message}`)));
});

test("--analyze --json answers an unreadable input with an error object", (t) => {
  const dir = tempDir(t);
  const input = join(dir, "not-an-extension.zip");
  writeFileSync(input, "this is not a zip archive");
  const res = runCli([input, "--analyze", "--json"], { state: tempDir(t) });

  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.convertible, false);
  assert.equal(typeof report.error, "string");
});

test("--strict makes a warning block --analyze", (t) => {
  // Firefox never matches a pattern with a port: a warning nothing fixes.
  const ext = writeFiles(tempDir(t), {
    "manifest.json": { manifest_version: 3, name: "Warned", version: "1.0", host_permissions: ["https://example.com:8443/*"] },
  });
  const state = tempDir(t);
  const lenient = runCli([ext, "--analyze", "--json"], { state });
  const strict = runCli([ext, "--analyze", "--json", "--strict"], { state });

  assert.equal(lenient.code, 0, lenient.stdout);
  assert.equal(JSON.parse(lenient.stdout).counts.warning > 0, true);
  assert.equal(strict.code, 1);
  assert.equal(JSON.parse(strict.stdout).convertible, false);
});
