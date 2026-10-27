// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { BidiSession } from "../dist/firefox/bidi.js";
import { quitFirefoxForProfile } from "../dist/firefox/launch.js";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { profileInUse } from "../dist/firefox/profiles.js";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

const firefox = selectFirefox(findFirefoxInstalls());
const noFirefox = firefox ? false : "no Firefox install found";

// Without --sign, --headless still installs temporarily: a Firefox without a
// window can't show the install prompt the other routes rely on.
test("--install --headless loads the add-on temporarily into Firefox, then quits it", { skip: noFirefox, timeout: 180_000 }, (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const profile = tempDir(t);
  const out = join(tempDir(t), "out");
  const res = runCli([ext, "--install", "--headless", "--profile", profile, "--addon-id", "panel@example.com", "-o", out], {
    state: tempDir(t),
  });

  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /› Signing \(temporary\)/);
  assert.ok(res.stderr.includes(`✓ Installed → ${profile}`), res.stderr);
  assert.match(res.stderr, /panel@example\.com/);
  assert.equal(profileInUse(profile), false, "the headless Firefox is still running");
});

test("a temporary install joins the remote-controlled Firefox already running on the profile", { skip: noFirefox, timeout: 180_000 }, async (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const profile = tempDir(t);
  const out = join(tempDir(t), "out");
  // Left running with its remote agent, the way a temporary install leaves Firefox.
  const first = await BidiSession.start(firefox, profile, { headless: true });
  await first.end();
  try {
    // Without a Firefox on the profile, the run below would start one with a window.
    assert.equal(profileInUse(profile), true);
    // Restarting Firefox would drop the add-ons it already has, and with
    // --no-firefox-restart the run would refuse to.
    const res = runCli(
      [ext, "--install", "--sign", "temporary", "--no-firefox-restart", "--profile", profile, "--addon-id", "panel@example.com", "-o", out],
      { state: tempDir(t) },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stderr.includes(`✓ Installed → ${profile}`), res.stderr);

    const check = await BidiSession.attach(firefox, profile);
    assert.ok(check, "the run left no remote-controlled Firefox behind");
    try {
      // Fails when the add-on isn't loaded in that Firefox.
      await check.uninstallExtension("panel@example.com");
    } finally {
      await check.closeBrowser();
    }
  } finally {
    if (profileInUse(profile)) {
      const session = await BidiSession.attach(firefox, profile);
      if (session) await session.closeBrowser();
      else await quitFirefoxForProfile(firefox, profile);
    }
  }
});
