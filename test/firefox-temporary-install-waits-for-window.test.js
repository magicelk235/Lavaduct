// Runs a real Firefox, headless and on a throwaway profile only.
//
// Firefox starts its devtools server before it opens its first window. The
// temporary route installed the add-on as soon as the server greeted, so the
// add-on's background could start with no window at all, and a tabs.create there
// (the usual welcome page) failed with "Not allowed to create tabs on the target
// window". Under load, cli-temporary-install.test.js lost the page the add-on
// opens that way. The session start() returns now waits for Firefox's window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RdpSession } from "../dist/firefox/rdp.js";
import { enableDebuggerServerInProfile } from "../dist/firefox/install.js";
import { quitFirefoxForProfile } from "../dist/firefox/launch.js";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { platform } from "../dist/firefox/platform/index.js";
import { profileInUse } from "../dist/firefox/profiles.js";

const firefox = selectFirefox(findFirefoxInstalls());

// On Windows taskkill can't close a Firefox without windows, and one left
// running keeps the profile locked and the test file from exiting.
async function stopFirefox(profile) {
  if (await quitFirefoxForProfile(firefox, profile)) return;
  const holder = platform.lockHolder(profile, { pathForName: () => undefined, defaultForBinary: () => undefined });
  if (holder) process.kill(holder.pid);
  for (let i = 0; i < 300 && profileInUse(profile); i++) await sleep(100);
}

test(
  "a Firefox started for a temporary install has its window open before anything is installed",
  { skip: firefox ? false : "no Firefox install found", timeout: 120_000 },
  async (t) => {
    const profile = mkdtempSync(join(tmpdir(), "lavaduct-window-"));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    enableDebuggerServerInProfile(profile);
    const session = await RdpSession.start(firefox, profile, { headless: true });
    try {
      const { tabs } = await session.request("root", "listTabs");
      assert.ok(tabs.length > 0, "Firefox had no window yet when the session was handed over");
    } finally {
      session.end();
      await stopFirefox(profile);
    }
  },
);
