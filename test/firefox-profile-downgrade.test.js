// Firefox refuses a profile a newer Firefox ran last ("This profile was last
// used with a newer version of this application"): with a window it shows a
// dialog, without one it quits. The temporary route's dedicated profile is
// shared by every install, so loading an add-on with Nightly and then with
// release (or with release and then ESR) left the second run waiting 30 s for
// a devtools server that never came up, ending in "connect ENOENT" (Nightly
// 162 then release 160, release 160 then ESR 153.7, headless).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { zipDirectory } from "../dist/zip/write.js";
import { quitFirefoxForProfile } from "../dist/firefox/launch.js";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { platform } from "../dist/firefox/platform/index.js";
import { profileDowngradeProblem, profileInUse, profileLastVersion } from "../dist/firefox/profiles.js";
import { runCli, runCliAsync, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

const realFirefox = selectFirefox(findFirefoxInstalls());

const install = (version) => ({ binary: "/nowhere/firefox", installDir: "/nowhere", channel: "release", version, requireSigning: true });

function profileLastRunBy(t, lastVersion) {
  const profile = tempDir(t);
  writeFileSync(
    join(profile, "compatibility.ini"),
    `[Compatibility]\r\nLastVersion=${lastVersion}\r\nLastOSABI=Darwin_aarch64-gcc3\r\n`,
  );
  return profile;
}

/** A folder --firefox accepts: an omni.ja with build constants and a binary that records being started. */
function fakeFirefox(t, version) {
  const src = tempDir(t);
  writeFiles(src, {
    "modules/AppConstants.sys.mjs":
      `export var AppConstants = Object.freeze({\n  MOZ_REQUIRE_SIGNING: true,\n  MOZ_UPDATE_CHANNEL: "release",\n  MOZ_APP_VERSION: "${version}",\n});\n`,
  });
  const dir = tempDir(t);
  zipDirectory(src, join(dir, "omni.ja"));
  const binary = join(dir, process.platform === "win32" ? "firefox.exe" : "firefox");
  writeFileSync(binary, `#!/bin/sh\ntouch "$(dirname "$0")/started"\n`);
  chmodSync(binary, 0o755);
  return dir;
}

test("the version that last ran a profile comes from its compatibility.ini", (t) => {
  assert.equal(profileLastVersion(profileLastRunBy(t, "162.0a1_20261111091117/20261111091117")), "162.0a1");
  assert.equal(profileLastVersion(profileLastRunBy(t, "153.7.0_20261020000000/20261020000000")), "153.7.0");
  assert.equal(profileLastVersion(profileLastRunBy(t, "Safe Mode")), undefined);
  assert.equal(profileLastVersion(tempDir(t)), undefined, "a profile no Firefox has run");
});

test("a profile a newer Firefox ran last is refused, an older or equal one isn't", (t) => {
  const nightlyProfile = profileLastRunBy(t, "162.0a1_20261111091117/20261111091117");
  assert.match(profileDowngradeProblem(install("160.0"), nightlyProfile) ?? "", /Firefox 162\.0a1 last used the profile .* Firefox 160\.0 won't open/);
  assert.equal(profileDowngradeProblem(install("162.0a1"), nightlyProfile), undefined);
  assert.equal(profileDowngradeProblem(install("162.0"), nightlyProfile), undefined, "162.0 is newer than 162.0a1");
  const releaseProfile = profileLastRunBy(t, "160.0_20261104181552/20261104181552");
  assert.match(profileDowngradeProblem(install("153.7.0"), releaseProfile) ?? "", /won't open a profile a newer Firefox has used/);
  assert.equal(profileDowngradeProblem(install("161.0"), releaseProfile), undefined);
  assert.equal(profileDowngradeProblem(install("153.7.0"), tempDir(t)), undefined);
});

test("MOZ_ALLOW_DOWNGRADE lets an older Firefox take the profile, as it does Firefox", (t) => {
  const profile = profileLastRunBy(t, "162.0a1_20261111091117/20261111091117");
  const saved = process.env.MOZ_ALLOW_DOWNGRADE;
  process.env.MOZ_ALLOW_DOWNGRADE = "1";
  try {
    assert.equal(profileDowngradeProblem(install("160.0"), profile), undefined);
  } finally {
    if (saved === undefined) delete process.env.MOZ_ALLOW_DOWNGRADE;
    else process.env.MOZ_ALLOW_DOWNGRADE = saved;
  }
});

test(
  "--install refuses a profile a newer Firefox ran last before converting or starting Firefox",
  { skip: process.platform === "win32" ? "needs a shell script as the fake binary" : false, timeout: 120_000 },
  (t) => {
    const firefox = fakeFirefox(t, "160.0");
    const profile = profileLastRunBy(t, "162.0a1_20261111091117/20261111091117");
    const ext = writeFiles(tempDir(t), sampleExtension());
    const out = join(tempDir(t), "out");
    const res = runCli([ext, "--install", "--sign", "temporary", "--firefox", firefox, "--profile", profile, "-o", out], {
      state: tempDir(t),
      env: { MOZ_HEADLESS: "1" },
    });
    assert.equal(res.code, 1, res.stderr);
    assert.match(res.stderr, /✗ Firefox 162\.0a1 last used the profile at .* Firefox 160\.0 won't open a profile a newer Firefox has used/);
    assert.doesNotMatch(res.stderr, /Staged →/);
  },
);

test(
  "--uninstall refuses a profile a newer Firefox ran last instead of starting Firefox on it",
  { skip: process.platform === "win32" ? "needs a shell script as the fake binary" : false, timeout: 120_000 },
  (t) => {
    const firefox = fakeFirefox(t, "153.7.0");
    const profile = profileLastRunBy(t, "160.0_20261104181552/20261104181552");
    writeFileSync(
      join(profile, "extensions.json"),
      JSON.stringify({
        schemaVersion: 36,
        addons: [{ id: "mine@example.com", type: "extension", version: "1.0", active: true, userDisabled: false, location: "app-profile", defaultLocale: { name: "Mine" } }],
      }),
    );
    mkdirSync(join(profile, "extensions"), { recursive: true });
    const res = runCli(["--uninstall", "mine@example.com", "--firefox", firefox, "--profile", profile], { state: tempDir(t) });
    assert.equal(res.code, 1, res.stderr);
    assert.match(res.stderr, /✗ Firefox 160\.0 last used the profile at .* Firefox 153\.7\.0 won't open/);
  },
);

// Joining a Firefox that already has the profile open starts nothing, so the
// version that last ran the profile doesn't matter there.
test(
  "a temporary install still joins a running Firefox whose profile a newer Firefox ran last",
  { skip: realFirefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    const profile = tempDir(t);
    const state = tempDir(t);
    const run = (name) =>
      runCliAsync(
        [writeFiles(tempDir(t), sampleExtension()), "--install", "--sign", "temporary", "--profile", profile,
          "--addon-id", `${name}@example.com`, "-o", join(tempDir(t), "out")],
        { state, env: { MOZ_HEADLESS: "1" } },
      );
    try {
      const first = await run("first");
      assert.equal(first.code, 0, first.stderr);
      // As if a newer Firefox had run the profile before this one started.
      writeFileSync(join(profile, "compatibility.ini"), "[Compatibility]\nLastVersion=999.0_20991231000000/20991231000000\n");
      const second = await run("second");
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stderr, /Using the Firefox that already has/);
    } finally {
      if (!(await quitFirefoxForProfile(realFirefox, profile))) {
        const holder = platform.lockHolder(profile, { pathForName: () => undefined, defaultForBinary: () => undefined });
        if (holder) process.kill(holder.pid);
      }
      for (let i = 0; i < 300 && profileInUse(profile); i++) await sleep(100);
    }
  },
);
