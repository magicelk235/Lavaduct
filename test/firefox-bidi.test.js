// Runs a real Firefox, headless and on throwaway profiles only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BidiSession } from "../dist/firefox/bidi.js";
import { openXpiInFirefox, quitFirefoxForProfile } from "../dist/firefox/launch.js";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { profileInUse } from "../dist/firefox/profiles.js";

const firefox = selectFirefox(findFirefoxInstalls());
const noFirefox = firefox ? false : "no Firefox install found";

async function withTempDirs(fn) {
  const profile = mkdtempSync(join(tmpdir(), "lavaduct-bidi-profile-"));
  const ext = mkdtempSync(join(tmpdir(), "lavaduct-bidi-ext-"));
  try {
    return await fn(profile, ext);
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }
}

test("a headless session installs and uninstalls an unpacked add-on", { skip: noFirefox, timeout: 180_000 }, async () => {
  await withTempDirs(async (profile, ext) => {
    writeFileSync(
      join(ext, "manifest.json"),
      JSON.stringify({
        manifest_version: 2,
        name: "BiDi probe",
        version: "1.0",
        browser_specific_settings: { gecko: { id: "bidi-probe@example.invalid" } },
      }),
    );
    const session = await BidiSession.start(firefox, profile, { headless: true });
    try {
      assert.equal(profileInUse(profile), true);
      // A running Firefox would swallow a second launch without starting its
      // remote agent, so a second session on the profile is refused up front.
      await assert.rejects(BidiSession.start(firefox, profile, { headless: true }), /already has the profile/);

      assert.equal(await session.installExtension(ext), "bidi-probe@example.invalid");
      await session.uninstallExtension("bidi-probe@example.invalid");
      await assert.rejects(session.uninstallExtension("bidi-probe@example.invalid"), /No add-on with the ID/);
      await assert.rejects(session.installExtension(join(ext, "missing")), /Nothing to install/);
    } finally {
      await session.closeBrowser();
    }
    assert.equal(profileInUse(profile), false);
  });
});

test(
  "quitting the Firefox that holds a profile frees it",
  {
    skip: noFirefox || (process.platform === "win32" ? "taskkill can't close a Firefox without windows" : false),
    timeout: 180_000,
  },
  async () => {
    await withTempDirs(async (profile) => {
      const session = await BidiSession.start(firefox, profile, { headless: true });
      // Ending the session leaves Firefox running with the profile open.
      await session.end();
      try {
        assert.equal(profileInUse(profile), true);
        assert.equal(await quitFirefoxForProfile(firefox, profile), true);
        assert.equal(profileInUse(profile), false);
      } finally {
        if (profileInUse(profile)) await session.closeBrowser().catch(() => {});
      }
    });
  },
);

test(
  "an .xpi isn't handed to a profile another Firefox install has open",
  {
    skip: noFirefox || (process.platform === "win32" ? "needs a shell script as the fake binary" : false),
    timeout: 180_000,
  },
  async () => {
    await withTempDirs(async (profile, other) => {
      // A second install whose binary would record that it was started.
      const installDir = join(other, "other-firefox");
      mkdirSync(installDir);
      const binary = join(installDir, "firefox");
      writeFileSync(binary, `#!/bin/sh\ntouch "${join(installDir, "started")}"\n`);
      chmodSync(binary, 0o755);
      const otherInstall = { binary, installDir, channel: "nightly", version: "161.0a1", requireSigning: false };

      const session = await BidiSession.start(firefox, profile, { headless: true });
      try {
        // The other install's Firefox would wait on the profile lock and then
        // show "Firefox is already running", so nothing is launched.
        assert.throws(
          () => openXpiInFirefox(otherInstall, { path: profile, isDefault: false }, join(other, "addon.xpi")),
          /is open in the Firefox at .*--firefox/,
        );
        assert.equal(existsSync(join(installDir, "started")), false);
      } finally {
        await session.closeBrowser();
      }
    });
  },
);
