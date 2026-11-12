// Runs a real Firefox, headless and on throwaway profiles only.
//
// Firefox reads user.js only when it starts. A run under --no-firefox-restart
// (or --no-launch) writes xpinstall.signatures.required = false into a profile
// Firefox has open and asks for a restart. The next run found the pref already
// in user.js, took that to mean Firefox had it, and handed the .xpi to the same
// Firefox, which still required signatures and refused the add-on as
// unverified (seen on Nightly 162 and Developer Edition 161).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { allowUnsignedInProfile } from "../dist/firefox/install.js";
import { launchFirefox, quitFirefoxForProfile, startedBeforeUserJs } from "../dist/firefox/launch.js";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { platform } from "../dist/firefox/platform/index.js";
import { profileInUse } from "../dist/firefox/profiles.js";
import { runCliAsync, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

const installs = findFirefoxInstalls();
const firefox = selectFirefox(installs);
const unsignedFirefox = installs.find((i) => !i.requireSigning);

async function startFirefox(install, profile) {
  launchFirefox(install, ["--profile", profile], { headless: true });
  for (let i = 0; i < 300 && !profileInUse(profile); i++) await sleep(100);
  assert.ok(profileInUse(profile), "Firefox never took the profile");
  // ps tells a process's age in whole seconds; anything written within the
  // second Firefox started counts as read.
  await sleep(2_000);
}

/** Stop the Firefox on the profile, including a windowless one taskkill can't close. */
async function stopFirefox(install, profile) {
  if (await quitFirefoxForProfile(install, profile)) return;
  const holder = platform.lockHolder(profile, { pathForName: () => undefined, defaultForBinary: () => undefined });
  if (holder) process.kill(holder.pid);
  for (let i = 0; i < 300 && profileInUse(profile); i++) await sleep(100);
}

test(
  "a Firefox that started before user.js was written is told apart from one started after",
  { skip: firefox ? false : "no Firefox install found", timeout: 180_000 },
  async (t) => {
    const profile = tempDir(t);
    try {
      await startFirefox(firefox, profile);
      assert.equal(startedBeforeUserJs(firefox, profile), false, "there is no user.js yet");
      allowUnsignedInProfile(profile);
      assert.equal(startedBeforeUserJs(firefox, profile), true, "user.js was written after this Firefox started");
      await stopFirefox(firefox, profile);
      assert.equal(startedBeforeUserJs(firefox, profile), false, "no Firefox has the profile open");

      await startFirefox(firefox, profile);
      assert.equal(startedBeforeUserJs(firefox, profile), false, "this Firefox read user.js when it started");
    } finally {
      await stopFirefox(firefox, profile);
    }
  },
);

test(
  "the unsigned route doesn't hand the .xpi to a Firefox that started before signature checks were turned off",
  { skip: unsignedFirefox ? false : "no Firefox that runs unsigned add-ons (Nightly, Developer Edition or ESR)", timeout: 240_000 },
  async (t) => {
    const ext = writeFiles(tempDir(t), sampleExtension());
    const profile = tempDir(t);
    const state = tempDir(t);
    const run = () =>
      runCliAsync(
        [ext, "--install", "--sign", "unsigned", "--firefox", unsignedFirefox.installDir, "--profile", profile,
          "--no-firefox-restart", "--addon-id", "unread@example.com", "-o", join(tempDir(t), "out")],
        // A Firefox started for the .xpi gets no window.
        { state, env: { MOZ_HEADLESS: "1" } },
      );
    try {
      await startFirefox(unsignedFirefox, profile);
      const first = await run();
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stderr, /Turned off signature checks/);
      assert.match(first.stderr, /reads that setting only when it starts/);

      // The user didn't restart Firefox before running again.
      const second = await run();
      assert.equal(second.code, 0, second.stderr);
      assert.doesNotMatch(second.stderr, /Installed →/, "the .xpi went to a Firefox that still requires signatures");
      assert.match(second.stderr, /started before signature checks were turned off/);
      assert.match(second.stderr, /reads that setting only when it starts/);
    } finally {
      await stopFirefox(unsignedFirefox, profile);
    }
  },
);
