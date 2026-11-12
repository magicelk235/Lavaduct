// Runs a real Firefox, headless and on throwaway profiles only.
//
// A temporary install joins the Firefox an earlier one left running on the
// profile. With release 160 running the dedicated profile, `--firefox nightly`
// joined it too and loaded the add-on into release, never starting the
// Nightly the run asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { quitFirefoxForProfile } from "../dist/firefox/launch.js";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { platform } from "../dist/firefox/platform/index.js";
import { profileInUse } from "../dist/firefox/profiles.js";
import { zipDirectory } from "../dist/zip/write.js";
import { runCliAsync, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

const firefox = selectFirefox(findFirefoxInstalls());
const skip = process.platform === "win32" ? "needs a shell script as the second install" : firefox ? false : "no Firefox install found";

/**
 * A second install for --firefox: its own folder with the real install's build
 * constants, and a binary that starts the real Firefox. Another channel
 * installed side by side looks the same to lavaduct.
 */
function secondInstall(t) {
  const src = tempDir(t);
  writeFiles(src, {
    "modules/AppConstants.sys.mjs":
      `export var AppConstants = Object.freeze({\n  MOZ_REQUIRE_SIGNING: ${firefox.requireSigning},\n` +
      `  MOZ_UPDATE_CHANNEL: "${firefox.channel}",\n  MOZ_APP_VERSION: "${firefox.version}",\n});\n`,
  });
  const dir = tempDir(t);
  zipDirectory(src, join(dir, "omni.ja"));
  writeFileSync(join(dir, "firefox"), `#!/bin/sh\nexec "${firefox.binary}" "$@"\n`);
  chmodSync(join(dir, "firefox"), 0o755);
  return dir;
}

test(
  "a temporary install with --firefox starts that Firefox instead of joining another install's",
  { skip, timeout: 240_000 },
  async (t) => {
    const profile = tempDir(t);
    const state = tempDir(t);
    const run = (name, extra = []) =>
      runCliAsync(
        [writeFiles(tempDir(t), sampleExtension()), "--install", "--sign", "temporary", "--profile", profile,
          "--addon-id", `${name}@example.com`, "-o", join(tempDir(t), "out"), ...extra],
        { state, env: { MOZ_HEADLESS: "1" } },
      );
    try {
      const first = await run("first");
      assert.equal(first.code, 0, first.stderr);

      const second = await run("second", ["--firefox", secondInstall(t)]);
      assert.equal(second.code, 0, second.stderr);
      assert.doesNotMatch(second.stderr, /Using the Firefox that already has/, "the add-on went into the other install's Firefox");
      assert.match(second.stderr, /is open in the Firefox at .*, not the one --firefox picks/);
      assert.match(second.stderr, /✓ Installed →/);

      // Without --firefox, the run joins whatever Firefox has the profile.
      const third = await run("third");
      assert.equal(third.code, 0, third.stderr);
      assert.match(third.stderr, /Using the Firefox that already has/);
    } finally {
      if (!(await quitFirefoxForProfile(firefox, profile))) {
        const holder = platform.lockHolder(profile, { pathForName: () => undefined, defaultForBinary: () => undefined });
        if (holder) process.kill(holder.pid);
      }
      for (let i = 0; i < 300 && profileInUse(profile); i++) await sleep(100);
    }
  },
);
