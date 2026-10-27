import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_FILE } from "../dist/name.js";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

test("the config file fills in flags the command line didn't give", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const cwd = writeFiles(tempDir(t), { [CONFIG_FILE]: { platforms: "android" } });
  const state = tempDir(t);

  const fromConfig = runCli([ext, "--analyze", "--json"], { cwd, state });
  assert.equal(fromConfig.code, 0, fromConfig.stderr);
  assert.equal(JSON.parse(fromConfig.stdout).platforms, "android");

  const fromFlag = runCli([ext, "--analyze", "--json", "--platforms", "all"], { cwd, state });
  assert.equal(fromFlag.code, 0, fromFlag.stderr);
  assert.equal(JSON.parse(fromFlag.stdout).platforms, "all");
});

test("a config value of the wrong type is ignored, not taken as true", (t) => {
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
  const cwd = writeFiles(tempDir(t), { [CONFIG_FILE]: { force: "false" } });
  const res = runCli([ext, "--no-launch", "-o", "out"], { cwd, state: tempDir(t) });

  assert.equal(res.code, 1, "a string \"false\" must not turn --force on");
  assert.match(res.stderr, /Ignoring config "force"/);
});

test("--json is refused for a batch, whose output wouldn't parse", (t) => {
  const a = writeFiles(tempDir(t), sampleExtension());
  const b = writeFiles(tempDir(t), sampleExtension());
  const res = runCli([a, b, "--analyze", "--json"], { state: tempDir(t) });

  assert.equal(res.code, 2);
  assert.equal(res.stdout.trim(), "");
  assert.match(res.stderr, /--json/);
});

test("a batch converts every input and fails when one of them does", (t) => {
  const good = writeFiles(tempDir(t), sampleExtension());
  const missing = `${good}-missing`;
  const cwd = tempDir(t);
  const res = runCli([good, missing, "--no-launch"], { cwd, state: tempDir(t) });

  assert.equal(res.code, 1);
  assert.match(res.stderr, /Done: Fixture Panel/);
  assert.match(res.stderr, /Input not found/);
  assert.match(res.stderr, /Batch finished with failures/);
});
