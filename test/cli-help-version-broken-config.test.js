import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG_FILE } from "../dist/name.js";
import { runCli, tempDir, writeFiles } from "./cli-helpers.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

// --version and --help read no config, so a broken one in the working directory
// can't stop them; a conversion still refuses it.
test("--version and --help work beside a config file that doesn't parse", (t) => {
  const cwd = writeFiles(tempDir(t), { [CONFIG_FILE]: "{ not json" });

  const version = runCli(["--version"], { cwd, state: tempDir(t) });
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), VERSION);

  const help = runCli(["--help"], { cwd, state: tempDir(t) });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /USAGE/);

  const convert = runCli(["whatever.zip"], { cwd, state: tempDir(t) });
  assert.equal(convert.code, 2);
  assert.match(convert.stderr, /^✗ Could not parse/m);
});
