// A folder input is often the extension's source tree, which can hold Chrome's
// packing key (key.pem), .env files, an .npmrc with a registry token and editor
// settings. Staging copied them all, so the .xpi carried them and the amo route
// uploaded them to Mozilla.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageExtension } from "../dist/input/stage.js";

function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), "stage-secrets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "src");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, rel)), { recursive: true });
    writeFileSync(join(src, rel), text);
  }
  return { src, stage: join(root, "stage") };
}

test("keys, env files, npm credentials and editor folders aren't staged", (t) => {
  const { src, stage } = tree(t, {
    "manifest.json": "{}",
    "background.js": "",
    "key.pem": "-----BEGIN PRIVATE KEY-----",
    "certs/dev.pem": "-----BEGIN CERTIFICATE-----",
    ".env": "API_SECRET=1",
    ".env.production.local": "API_SECRET=2",
    ".npmrc": "//registry.npmjs.org/:_authToken=x",
    ".vscode/settings.json": "{}",
    ".idea/workspace.xml": "<project/>",
    "environment.js": "",
  });
  stageExtension(src, stage);
  for (const gone of ["key.pem", "certs/dev.pem", ".env", ".env.production.local", ".npmrc", ".vscode", ".idea"]) {
    assert.equal(existsSync(join(stage, gone)), false, `${gone} was staged`);
  }
  for (const kept of ["manifest.json", "background.js", "environment.js"]) assert.ok(existsSync(join(stage, kept)), `${kept} is missing`);
});

test("a .pem the manifest names still ships", (t) => {
  const { src, stage } = tree(t, { "manifest.json": "{}", "public/ca.pem": "-----BEGIN CERTIFICATE-----" });
  stageExtension(src, stage, new Set(["public/ca.pem"]));
  assert.ok(existsSync(join(stage, "public/ca.pem")));
});
