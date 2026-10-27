import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_PREFIX, DEDICATED_PROFILE } from "../dist/name.js";
import { installHash } from "../dist/firefox/cityhash.js";
import {
  dedicatedProfile,
  listProfiles,
  parseProfilesIni,
  pickDefaultProfile,
  resolveProfile,
} from "../dist/firefox/profiles.js";
import { withFakeHome } from "./firefox-fixtures.js";

// profiles.ini as Firefox 158 writes it on macOS: a per-install default plus
// the legacy Default=1 profile left from older versions.
const MAC_PROFILES_INI = `[General]
StartWithLastProfile=1
Version=2

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/qoyivkdt.default-release

[Install2656FF1E876E9973]
Default=Profiles/qoyivkdt.default-release
Locked=1

[Profile1]
Name=default
IsRelative=1
Path=Profiles/tgn1pkvb.default
Default=1
`;

test("an install's default profile comes from its [Install<hash>] section, not Default=1", () => {
  const root = "/Users/me/Library/Application Support/Firefox";
  const ini = parseProfilesIni(MAC_PROFILES_INI, root);
  const def = pickDefaultProfile(ini, { hash: "2656FF1E876E9973", legacy: false });
  assert.equal(def?.name, "default-release");
  assert.equal(def?.path, join(root, "Profiles/qoyivkdt.default-release"));
  // A second install that has never started has no default yet.
  assert.equal(pickDefaultProfile(ini, { hash: "308046B0AF4A39CB", legacy: false }), undefined);
});

test("snap Firefox, which writes no [Install…] sections, defaults to the Default=1 profile", () => {
  const snapIni = `[General]
StartWithLastProfile=1

[Profile0]
Name=work
IsRelative=1
Path=abcd1234.work

[Profile1]
Name=default
IsRelative=1
Path=efgh5678.default
Default=1
`;
  const root = "/home/me/snap/firefox/common/.mozilla/firefox";
  const ini = parseProfilesIni(snapIni, root);
  assert.equal(pickDefaultProfile(ini, { hash: "4F96D1932A9F858E", legacy: true })?.name, "default");
  // Legacy mode also applies when the file has no install sections at all.
  assert.equal(pickDefaultProfile(ini, { hash: "4F96D1932A9F858E", legacy: false })?.name, "default");
  // In legacy mode a lone profile is the default even without Default=1.
  const lone = parseProfilesIni("[Profile0]\nName=only\nIsRelative=1\nPath=x.only\n", root);
  assert.equal(pickDefaultProfile(lone, { hash: "", legacy: true })?.name, "only");
});

test("relative profile paths resolve against the root; absolute ones are kept as written", () => {
  const text = `[General]
Version=2

[Profile0]
Name=custom
IsRelative=0
Path=/srv/firefox-profiles/custom

[Profile1]
Name=default-release
IsRelative=1
Path=Profiles/zz.default-release

[Install4F96D1932A9F858E]
Default=/srv/firefox-profiles/custom
`;
  const ini = parseProfilesIni(text, "/home/me/.mozilla/firefox");
  const byName = Object.fromEntries(ini.profiles.map((p) => [p.name, p.path]));
  assert.equal(byName.custom, "/srv/firefox-profiles/custom");
  assert.equal(byName["default-release"], join("/home/me/.mozilla/firefox", "Profiles/zz.default-release"));
  assert.equal(pickDefaultProfile(ini, { hash: "4F96D1932A9F858E", legacy: false })?.name, "custom");
});

test("install defaults come back from installs.ini after an old Firefox rewrote profiles.ini", () => {
  // Firefox before 67 drops [General] Version and the install sections.
  const oldStyle = `[General]
StartWithLastProfile=1

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/qoyivkdt.default-release

[Profile1]
Name=default
IsRelative=1
Path=Profiles/tgn1pkvb.default
Default=1
`;
  const installsIni = "[2656FF1E876E9973]\nDefault=Profiles/qoyivkdt.default-release\nLocked=1\n";
  const ini = parseProfilesIni(oldStyle, "/root", installsIni);
  assert.equal(pickDefaultProfile(ini, { hash: "2656FF1E876E9973", legacy: false })?.name, "default-release");
  // A current profiles.ini wins over a stale backup.
  const current = parseProfilesIni(MAC_PROFILES_INI, "/root", "[2656FF1E876E9973]\nDefault=Profiles/tgn1pkvb.default\n");
  assert.equal(pickDefaultProfile(current, { hash: "2656FF1E876E9973", legacy: false })?.name, "default-release");
});

test("--profile resolves the install's default, names and paths from the profile root", async () => {
  await withFakeHome(({ root, install }) => {
    const hash = installHash(realpathSync.native(install.installDir));
    writeFileSync(
      join(root, "profiles.ini"),
      `[General]\nVersion=2\n\n[Profile0]\nName=work\nIsRelative=1\nPath=Profiles/a.work\n\n` +
        `[Profile1]\nName=default-release\nIsRelative=1\nPath=Profiles/b.default-release\n\n` +
        `[Install${hash}]\nDefault=Profiles/b.default-release\nLocked=1\n`,
    );
    for (const dir of ["a.work", "b.default-release"]) mkdirSync(join(root, "Profiles", dir), { recursive: true });

    const def = resolveProfile(undefined, install);
    assert.deepEqual(def, { name: "default-release", path: join(root, "Profiles/b.default-release"), isDefault: true });
    assert.deepEqual(resolveProfile("work", install), { name: "work", path: join(root, "Profiles/a.work"), isDefault: false });
    // A registered profile given by path keeps its name, so it can be opened with -P.
    assert.equal(resolveProfile(join(root, "Profiles", "a.work"), install).name, "work");
    assert.deepEqual(
      listProfiles().map((p) => [p.name, p.isDefault]),
      [
        ["work", false],
        ["default-release", true],
      ],
    );
  });
});

test("--profile refuses unknown names and missing paths, naming the fix", async () => {
  await withFakeHome(({ home, install }) => {
    const loose = join(home, "loose-profile");
    mkdirSync(loose);
    assert.deepEqual(resolveProfile(loose, install), { path: loose, isDefault: false });
    assert.throws(() => resolveProfile("no-such-profile", install), /No Firefox profile named.*--doctor/);
    assert.throws(() => resolveProfile(join(home, "missing"), install), /No Firefox profile at/);
    // No profiles.ini yet: Firefox hasn't been started.
    assert.throws(() => resolveProfile(undefined, install), /no default profile yet.*--profile/);
  });
});

test("the dedicated profile lives in the state directory and answers to its name", async () => {
  await withFakeHome(({ install }) => {
    const state = mkdtempSync(join(tmpdir(), "lavaduct-state-"));
    const key = `${ENV_PREFIX}_STATE_DIR`;
    const saved = process.env[key];
    process.env[key] = state;
    try {
      const profile = dedicatedProfile(install);
      assert.equal(profile.path, join(state, "profiles", DEDICATED_PROFILE));
      assert.ok(existsSync(profile.path));
      assert.equal(resolveProfile(DEDICATED_PROFILE, install).path, profile.path);
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
      rmSync(state, { recursive: true, force: true });
    }
  });
});

test("snap and Flatpak Firefox get the dedicated profile where their sandbox can write", async () => {
  await withFakeHome(({ home, install }) => {
    // The state directory sits in a hidden folder neither sandbox can reach.
    const snap = { ...install, sandbox: "snap" };
    const snapProfile = join(home, "snap", "firefox", "common", `${DEDICATED_PROFILE}-profile`);
    assert.deepEqual(dedicatedProfile(snap), { path: snapProfile, isDefault: false });
    assert.ok(existsSync(snapProfile));
    assert.equal(resolveProfile(DEDICATED_PROFILE, snap).path, snapProfile);

    const flatpak = { ...install, sandbox: "flatpak" };
    const flatpakProfile = join(home, ".var", "app", "org.mozilla.firefox", `${DEDICATED_PROFILE}-profile`);
    assert.deepEqual(dedicatedProfile(flatpak), { path: flatpakProfile, isDefault: false });
    assert.ok(existsSync(flatpakProfile));
  });
});
