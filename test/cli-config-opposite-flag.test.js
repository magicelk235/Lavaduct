import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE } from "../dist/name.js";
import { SHIM_FILENAME } from "../dist/runtime/shim.js";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

// A typed flag wins over the config, including a config key that switches the
// opposite way: the config value gives way instead of contradicting the flag.
for (const [config, flag] of [
  [{ "native-hosts": true }, "--no-native-hosts"],
  [{ "no-native-hosts": true }, "--native-hosts"],
  [{ debug: true }, "--no-shim"],
]) {
  test(`a typed ${flag} overrides config ${JSON.stringify(config)}`, (t) => {
    const ext = writeFiles(tempDir(t), sampleExtension());
    const cwd = writeFiles(tempDir(t), { [CONFIG_FILE]: config });
    const res = runCli([ext, "--no-launch", "-o", "out", flag], { cwd, state: tempDir(t) });

    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(join(cwd, "out", "staged_extension", "manifest.json")));
  });
}

test("a typed --debug overrides config no-shim", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const cwd = writeFiles(tempDir(t), { [CONFIG_FILE]: { "no-shim": true } });
  const res = runCli([ext, "--no-launch", "-o", "out", "--debug"], { cwd, state: tempDir(t) });

  assert.equal(res.code, 0, res.stderr);
  const manifest = JSON.parse(readFileSync(join(cwd, "out", "staged_extension", "manifest.json"), "utf-8"));
  assert.ok(manifest.background.scripts.includes(SHIM_FILENAME), "the debug build has the shim");
});

test("both opposite flags typed still contradict each other", (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const res = runCli([ext, "--no-launch", "-o", "out", "--native-hosts", "--no-native-hosts"], { cwd: tempDir(t), state: tempDir(t) });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /^✗ .*contradict/m);
});
