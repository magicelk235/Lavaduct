// Shared setup for the Firefox tests: a throwaway home directory, so profile
// discovery reads fixture files instead of the real Firefox profiles.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VARS = ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME", "MOZ_LEGACY_HOME"];

/** Where Firefox keeps profiles.ini under `home` on this OS. */
export function profileRootUnder(home) {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Firefox");
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "Mozilla", "Firefox");
  return join(home, ".mozilla", "firefox");
}

/**
 * Run `fn({ home, root, install })` with the home directory pointing at a temp
 * dir that has an empty profile root and a fake install directory.
 */
export async function withFakeHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "lavaduct-home-"));
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.MOZ_LEGACY_HOME;
  const root = profileRootUnder(home);
  mkdirSync(root, { recursive: true });
  const installDir = join(home, "firefox-install");
  mkdirSync(installDir);
  const install = {
    binary: join(installDir, process.platform === "win32" ? "firefox.exe" : "firefox"),
    installDir,
    channel: "release",
    version: "159.0",
    requireSigning: true,
  };
  try {
    return await fn({ home, root, install });
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  }
}
