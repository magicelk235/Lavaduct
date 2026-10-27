import { existsSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../../util.js";
import type { InstallCandidate, Platform } from "./index.js";
import { symlinkLockHolder } from "./shared.js";

// Names the Mozilla disk images use, plus the older unbranded Nightly name.
const APP_NAMES = [
  "Firefox.app",
  "Firefox Developer Edition.app",
  "Firefox Nightly.app",
  "Firefox Beta.app",
  "Firefox ESR.app",
  "Nightly.app",
];

// Release, Beta and ESR all use org.mozilla.firefox.
const BUNDLE_IDS = ["org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly"];

function appCandidate(app: string): InstallCandidate | undefined {
  const installDir = join(app, "Contents", "MacOS");
  const binary = join(installDir, "firefox");
  return existsSync(binary) ? { binary, installDir } : undefined;
}

/**
 * PIDs holding the profile's `.parentlock`. Firefox keeps it open for writing,
 * fcntl-locked, while it runs; readers such as Spotlight don't count.
 */
function lockHolders(profilePath: string): number[] {
  const lock = join(profilePath, ".parentlock");
  try {
    if (lstatSync(lock).isSymbolicLink()) {
      const pid = symlinkLockHolder(lock);
      return pid === undefined ? [] : [pid];
    }
  } catch {
    return [];
  }
  // -F pa prints "p<pid>" per process, then "f<fd>" and "a<r|w|u>" per open file.
  const res = run("/usr/sbin/lsof", ["-w", "-F", "pa", "--", lock]);
  const pids: number[] = [];
  let pid = 0;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if ((line === "aw" || line === "au") && pid && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

export const darwin: Platform = {
  installCandidates() {
    const apps: string[] = [];
    for (const dir of ["/Applications", join(homedir(), "Applications")]) {
      for (const name of APP_NAMES) apps.push(join(dir, name));
    }
    // Spotlight finds renamed copies and other folders. Skip the Trash and
    // mounted disk images.
    const query = BUNDLE_IDS.map((id) => `kMDItemCFBundleIdentifier == '${id}'`).join(" || ");
    const found = run("/usr/bin/mdfind", [query], { timeout: 10_000 });
    for (const app of found.stdout.split("\n")) {
      if (app.endsWith(".app") && !app.includes("/.Trash/") && !app.startsWith("/Volumes/")) apps.push(app);
    }
    return apps.flatMap((app) => appCandidate(app) ?? []);
  },

  candidateFromPath(path) {
    if (/\.app\/?$/.test(path)) return appCandidate(path);
    const binary = statSync(path, { throwIfNoEntry: false })?.isDirectory() ? join(path, "firefox") : path;
    return existsSync(binary) ? { binary, installDir: dirname(binary) } : undefined;
  },

  profileRoots() {
    return [join(homedir(), "Library", "Application Support", "Firefox")];
  },

  profileSetup(install) {
    return { roots: this.profileRoots(), hashDir: install.installDir, legacy: false };
  },

  profileLocked(profilePath) {
    return lockHolders(profilePath).length > 0;
  },

  lockHolder(profilePath) {
    const pid = lockHolders(profilePath)[0];
    if (pid === undefined) return undefined;
    // ps prints the full path of the running executable as the command name.
    const exe = run("/bin/ps", ["-o", "comm=", "-p", String(pid)]).stdout.trim();
    return { pid, exe: exe || undefined };
  },

  requestQuit(pid) {
    // A quit Apple Event sent to that one process, so another Firefox
    // running a different profile is left alone. Firefox saves its session
    // and may still ask the user about closing tabs.
    const script =
      `ObjC.import("AppKit"); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); ` +
      `app.isNil() ? "missing" : app.terminate ? "sent" : "refused"`;
    const res = run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
    return res.code === 0 && res.stdout.trim() === "sent";
  },

  visibleLaunchArgs() {
    // Started from a terminal, Firefox would otherwise open behind it.
    return ["-foreground"];
  },
};
