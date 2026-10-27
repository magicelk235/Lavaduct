import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_PREFIX } from "../dist/name.js";
import {
  allowUnsignedInProfile,
  recordInstall,
  recordedInstalls,
  waitForAddon,
} from "../dist/firefox/install.js";

async function withDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function extensionsJson(addons) {
  return JSON.stringify({
    schemaVersion: 37,
    addons: addons.map((a) => ({ type: "extension", hidden: false, location: "app-profile", ...a })),
  });
}

test("allowUnsignedInProfile replaces an existing signing pref and keeps the rest of user.js", async () => {
  await withDir("lavaduct-userjs-", (profile) => {
    const userJs = join(profile, "user.js");
    writeFileSync(
      userJs,
      'user_pref("browser.startup.page", 3);\n' +
        'user_pref("xpinstall.signatures.required", true);\n' +
        'user_pref("general.smoothScroll", false);\n',
    );
    assert.deepEqual(allowUnsignedInProfile(profile), { changed: true });
    assert.equal(
      readFileSync(userJs, "utf-8"),
      'user_pref("browser.startup.page", 3);\n' +
        'user_pref("xpinstall.signatures.required", false);\n' +
        'user_pref("general.smoothScroll", false);\n',
    );
    // Already set: nothing changes, so a running Firefox needs no restart.
    assert.deepEqual(allowUnsignedInProfile(profile), { changed: false });
  });
});

test("allowUnsignedInProfile creates user.js in a profile that has none", async () => {
  await withDir("lavaduct-userjs-", (profile) => {
    assert.deepEqual(allowUnsignedInProfile(profile), { changed: true });
    assert.equal(readFileSync(join(profile, "user.js"), "utf-8"), 'user_pref("xpinstall.signatures.required", false);\n');
  });
});

test("waitForAddon resolves once the add-on is enabled at the expected version", async () => {
  await withDir("lavaduct-wait-", async (profile) => {
    const file = join(profile, "extensions.json");
    writeFileSync(file, extensionsJson([{ id: "a@lavaduct", version: "1.0", active: true, userDisabled: false }]));
    // The prompt was accepted a moment later and Firefox recorded the new version.
    setTimeout(() => {
      writeFileSync(file, extensionsJson([{ id: "a@lavaduct", version: "1.1", active: true, userDisabled: false }]));
    }, 300);
    assert.equal(await waitForAddon(profile, "a@lavaduct", "1.1", 5000), true);
  });
});

test("waitForAddon gives up on a disabled add-on or a different version", async () => {
  await withDir("lavaduct-wait-", async (profile) => {
    writeFileSync(
      join(profile, "extensions.json"),
      extensionsJson([
        { id: "a@lavaduct", version: "1.0", active: true, userDisabled: false },
        { id: "b@lavaduct", version: "2.0", active: false, userDisabled: true },
      ]),
    );
    const started = Date.now();
    assert.equal(await waitForAddon(profile, "a@lavaduct", "1.1", 600), false);
    assert.equal(await waitForAddon(profile, "b@lavaduct", "2.0", 600), false);
    assert.ok(Date.now() - started < 3000);
  });
});

test("recordInstall keeps one record per add-on and profile", async () => {
  await withDir("lavaduct-state-", (state) => {
    const key = `${ENV_PREFIX}_STATE_DIR`;
    const saved = process.env[key];
    process.env[key] = state;
    try {
      const base = { id: "x@lavaduct", name: "X", route: "unsigned", installedAt: "2026-10-27T10:00:00.000Z" };
      recordInstall({ ...base, version: "1.0", profilePath: "/profiles/a" });
      recordInstall({ ...base, version: "1.0", profilePath: "/profiles/b" });
      recordInstall({ ...base, version: "1.1", profilePath: "/profiles/a", installedAt: "2026-10-27T11:00:00.000Z" });
      const records = recordedInstalls();
      assert.deepEqual(
        records.map((r) => [r.profilePath, r.version]),
        [
          ["/profiles/b", "1.0"],
          ["/profiles/a", "1.1"],
        ],
      );
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
});
