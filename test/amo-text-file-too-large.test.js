// AMO's validator (addons-linter) refuses any file it reads as text, JavaScript,
// HTML, JSON or a language pack, of 5 MiB or more (FILE_TOO_LARGE, a validation
// error), so AMO won't sign the add-on. Real bundles hit it: LastPass, Loom and
// Honey ship 5 to 9 MiB scripts. The amo route uploaded anyway and only learned
// after AMO's validation; it now says so up front and stops before uploading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV_PREFIX } from "../dist/name.js";
import { filesTooLargeForAmo } from "../dist/sign/amo.js";
import { runCli, tempDir, writeFiles } from "./cli-helpers.js";

const MIB = 1024 * 1024;

function big(t) {
  const dir = mkdtempSync(join(tmpdir(), "amo-large-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("text files of 5 MiB or more are flagged; smaller ones and binary types aren't", (t) => {
  const dir = writeFiles(big(t), { "lib/vendor.js": "", "rules.json": "", "under.js": "", "style.css": "", "model.wasm": "" });
  writeFileSync(join(dir, "lib/vendor.js"), Buffer.alloc(5 * MIB, 0x20));
  writeFileSync(join(dir, "rules.json"), Buffer.alloc(6 * MIB, 0x20));
  writeFileSync(join(dir, "under.js"), Buffer.alloc(5 * MIB - 1, 0x20));
  writeFileSync(join(dir, "style.css"), Buffer.alloc(6 * MIB, 0x20));
  writeFileSync(join(dir, "model.wasm"), Buffer.alloc(6 * MIB, 0x20));
  const issues = filesTooLargeForAmo(dir);
  assert.deepEqual(issues.map((i) => i.file).sort(), ["lib/vendor.js", "rules.json"]);
  for (const i of issues) assert.equal(i.category, "amo");
});

function extension(t) {
  const ext = writeFiles(join(tempDir(t), "ext"), {
    "manifest.json": { manifest_version: 3, name: "Heavy", version: "1.0", background: { service_worker: "bg.js" } },
    "bg.js": "",
  });
  writeFileSync(join(ext, "bg.js"), `/* ${"x".repeat(5 * MIB)} */\n`);
  return ext;
}

test("--analyze reports the file as a warning", (t) => {
  const res = runCli([extension(t), "--analyze", "--json"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr);
  const issue = JSON.parse(res.stdout).issues.find((i) => i.category === "amo");
  assert.equal(issue?.file, "bg.js");
  assert.equal(issue.severity, "warning");
});

test("--sign amo stops before uploading, even with --force", (t) => {
  const scratch = tempDir(t);
  const out = join(scratch, "out");
  // Nothing in this test may reach addons.mozilla.org.
  const block = join(scratch, "block-fetch.mjs");
  writeFileSync(block, 'globalThis.fetch = () => { throw new Error("network blocked by the test"); };\n');
  const env = {
    [`${ENV_PREFIX}_AMO_KEY`]: "user:1:1",
    [`${ENV_PREFIX}_AMO_SECRET`]: "secret",
    NODE_OPTIONS: `--import=${pathToFileURL(block).href}`,
  };
  const res = runCli([extension(t), "--sign", "amo", "--no-launch", "--force", "-o", out], { state: tempDir(t), env });
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /AMO won't sign an add-on with text files of 5 MiB or more \(bg\.js\); nothing was uploaded/);
  assert.doesNotMatch(res.stdout + res.stderr, /network blocked/);
  assert.match(readFileSync(join(out, "CONVERSION_REPORT.md"), "utf-8"), /bg\.js.*FILE_TOO_LARGE/);
});
