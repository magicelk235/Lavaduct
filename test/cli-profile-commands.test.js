import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { NAME } from "../dist/name.js";
import { runCli, tempDir, writeFiles } from "./cli-helpers.js";

const FIXTURE_PROFILE = fileURLToPath(new URL("./fixtures/storage/profile/", import.meta.url));
const noFirefox = selectFirefox(findFirefoxInstalls()) ? false : "no Firefox install found";

const ADDONS = {
  schemaVersion: 36,
  addons: [
    {
      id: "mine@example.com",
      type: "extension",
      version: "1.0",
      active: true,
      userDisabled: false,
      location: "app-profile",
      defaultLocale: { name: "Mine" },
    },
    {
      id: "theirs@example.com",
      type: "extension",
      version: "2.0",
      active: false,
      userDisabled: true,
      location: "app-profile",
      defaultLocale: { name: "Theirs" },
    },
  ],
};

test("--logs prints a --debug build's log from a profile directory", (t) => {
  const profile = tempDir(t);
  cpSync(FIXTURE_PROFILE, profile, { recursive: true });
  const res = runCli(["--logs", "small@fixture.test", "--profile", profile], { home: tempDir(t), state: tempDir(t) });

  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.stdout.trimEnd().split("\n"), [
    `${new Date(1793091600123).toISOString()} [background] [console.warn] storage at 80%`,
    `${new Date(1793091601456).toISOString()} [content] naïve café`,
    `${new Date(1793091602789).toISOString()} [page] [uncaught] 日本語 🚀 — failed`,
  ]);
  assert.match(res.stderr, /3 entries from /);
});

test("--logs names the problem when the add-on has no log", (t) => {
  const profile = tempDir(t);
  cpSync(FIXTURE_PROFILE, profile, { recursive: true });
  const res = runCli(["--logs", "nolog@fixture.test", "--profile", profile], { home: tempDir(t), state: tempDir(t) });

  assert.equal(res.code, 1);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /no debug log/);
});

test("--list shows a profile's add-ons and marks the ones this tool installed", (t) => {
  const profile = writeFiles(tempDir(t), { "extensions.json": ADDONS });
  const state = tempDir(t);
  writeFiles(join(state, "state"), {
    "installs.json": [
      {
        id: "mine@example.com",
        name: "Mine",
        version: "1.0",
        profilePath: profile,
        route: "unsigned",
        installedAt: "2026-10-28T10:00:00.000Z",
      },
    ],
  });
  const res = runCli(["--list", "--profile", profile], { home: tempDir(t), state });

  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split("\n");
  const mine = lines.find((l) => l.includes("mine@example.com"));
  const theirs = lines.find((l) => l.includes("theirs@example.com"));
  assert.ok(mine && theirs, res.stdout);
  assert.match(mine, /Mine.*1\.0.*enabled/);
  assert.match(mine, new RegExp(`installed by ${NAME}`));
  assert.match(theirs, /Theirs.*2\.0.*disabled/);
  assert.doesNotMatch(theirs, new RegExp(`installed by ${NAME}`));
});

test("--uninstall of an add-on the profile doesn't have fails before starting Firefox", { skip: noFirefox }, (t) => {
  const profile = writeFiles(tempDir(t), { "extensions.json": ADDONS });
  const res = runCli(["--uninstall", "Nobody", "--profile", profile], { home: tempDir(t), state: tempDir(t) });

  assert.equal(res.code, 1);
  assert.match(res.stderr, /"Nobody"/);
  assert.doesNotMatch(res.stderr, /Removing/);
});
