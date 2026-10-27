import { closeSync, existsSync, openSync, readFileSync, readSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { which } from "../../util.js";
import type { InstallCandidate, Platform } from "./index.js";
import { symlinkLockHolder } from "./shared.js";

const PATH_NAMES = ["firefox", "firefox-esr", "firefox-developer-edition", "firefox-nightly"];

const SNAP_INSTALL = "snap/firefox/current/usr/lib/firefox";
const SNAP_LAUNCHER = "snap/bin/firefox";
const FLATPAK_INSTALL = "app/org.mozilla.firefox/current/active/files/lib/firefox";
const FLATPAK_LAUNCHER = "exports/bin/org.mozilla.firefox";
/** Where the Flatpak build sits inside its sandbox; its profiles.ini section hashes this path. */
const FLATPAK_SANDBOX_DIR = "/app/lib/firefox";

/**
 * Map something on PATH to the install it starts. Distros either symlink into
 * the install directory or ship a shell wrapper that execs the real binary,
 * so look at the target's directory first and then at the absolute paths the
 * wrapper mentions: the binary itself (`exec /usr/lib/firefox/firefox`) or a
 * library directory it appends `firefox` to (Fedora's `MOZ_LIB_DIR="/usr/lib64"`).
 * `sysRoot` prefixes those paths (tests point it at a fixture tree).
 */
export function resolveLauncher(launcher: string, sysRoot = "/"): InstallCandidate | undefined {
  let real: string;
  try {
    real = realpathSync(launcher);
  } catch {
    return undefined;
  }
  if (existsSync(join(dirname(real), "omni.ja"))) return { binary: launcher, installDir: dirname(real) };

  const head = Buffer.alloc(64 * 1024);
  let length: number;
  try {
    const fd = openSync(real, "r");
    try {
      length = readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const text = head.subarray(0, length).toString("utf-8");
  if (!text.startsWith("#!")) return undefined;
  for (const [token] of text.matchAll(/\/[\w.+@/-]+/g)) {
    for (const dir of [token, dirname(token), join(token, "firefox")]) {
      const installDir = join(sysRoot, dir);
      if (existsSync(join(installDir, "omni.ja"))) return { binary: launcher, installDir };
    }
  }
  return undefined;
}

/**
 * Installs reachable from PATH, the snap and the Flatpak (system-wide and per
 * user). Ubuntu's /usr/bin/firefox only forwards to the snap, so PATH hits
 * that lead nowhere are left to the snap probe.
 */
export function linuxInstallCandidates(sysRoot = "/", home = homedir()): InstallCandidate[] {
  const out: InstallCandidate[] = [];
  for (const name of PATH_NAMES) {
    const hit = which(name);
    const candidate = hit ? resolveLauncher(hit, sysRoot) : undefined;
    if (candidate) out.push(candidate);
  }
  const snapDir = join(sysRoot, SNAP_INSTALL);
  if (existsSync(join(snapDir, "omni.ja"))) out.push({ binary: join(sysRoot, SNAP_LAUNCHER), installDir: snapDir });
  for (const base of [join(sysRoot, "var/lib/flatpak"), join(home, ".local/share/flatpak")]) {
    const installDir = join(base, FLATPAK_INSTALL);
    const binary = join(base, FLATPAK_LAUNCHER);
    if (existsSync(join(installDir, "omni.ja")) && existsSync(binary)) out.push({ binary, installDir });
  }
  return out;
}

function sandboxOf(installDir: string): "snap" | "flatpak" | undefined {
  if (installDir.includes("/snap/firefox/")) return "snap";
  if (installDir.includes("/flatpak/app/org.mozilla.firefox/")) return "flatpak";
  return undefined;
}

/**
 * The profiles.ini directory an install reads. Firefox 147+ uses
 * $XDG_CONFIG_HOME/mozilla/firefox unless ~/.mozilla already exists or
 * MOZ_LEGACY_HOME=1. The snap keeps the legacy layout under its own $HOME.
 * The Flatpak persists ~/.mozilla in its app directory and points
 * XDG_CONFIG_HOME at the app's config directory.
 */
export function linuxProfileRoot(
  installDir: string,
  home: string,
  env: { XDG_CONFIG_HOME?: string; MOZ_LEGACY_HOME?: string },
): string {
  const sandbox = sandboxOf(installDir);
  if (sandbox === "snap") return join(home, "snap", "firefox", "common", ".mozilla", "firefox");
  if (sandbox === "flatpak") {
    const app = join(home, ".var", "app", "org.mozilla.firefox");
    return existsSync(join(app, ".mozilla"))
      ? join(app, ".mozilla", "firefox")
      : join(app, "config", "mozilla", "firefox");
  }
  if (existsSync(join(home, ".mozilla")) || env.MOZ_LEGACY_HOME?.startsWith("1")) {
    return join(home, ".mozilla", "firefox");
  }
  // Firefox ignores a relative XDG_CONFIG_HOME, as the XDG spec says to.
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(xdg, "mozilla", "firefox");
}

/**
 * The POSIX lock on an inode as listed in /proc/locks
 * (`1: POSIX ADVISORY WRITE <pid> <maj>:<min>:<inode> 0 EOF`). Only the inode
 * is compared: btrfs and overlayfs report a different device to stat() than
 * the one /proc/locks prints. The PID is -1 for open-file-description locks.
 */
export function procLocksHolder(procLocks: string, inode: bigint): { pid: number } | undefined {
  for (const line of procLocks.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // "->" marks a process waiting for the lock, not holding it.
    if (fields.length < 6 || fields[1] === "->") continue;
    const ino = fields[5].split(":")[2];
    if (ino && /^\d+$/.test(ino) && BigInt(ino) === inode) return { pid: Number(fields[4]) };
  }
  return undefined;
}

/**
 * Firefox holds an fcntl lock on `.parentlock` and also writes a `lock`
 * symlink. /proc/locks shows the fcntl lock with a PID from this process's
 * namespace, which also covers the Flatpak's sandboxed Firefox. The symlink is
 * the fallback where /proc/locks isn't available.
 */
function lockState(profilePath: string): { locked: boolean; pid?: number } {
  const stat = statSync(join(profilePath, ".parentlock"), { bigint: true, throwIfNoEntry: false });
  if (stat) {
    let procLocks: string | undefined;
    try {
      procLocks = readFileSync("/proc/locks", "utf-8");
    } catch {
      procLocks = undefined;
    }
    if (procLocks !== undefined) {
      const holder = procLocksHolder(procLocks, stat.ino);
      if (!holder) return { locked: false };
      return { locked: true, pid: holder.pid > 0 ? holder.pid : undefined };
    }
  }
  const pid = symlinkLockHolder(join(profilePath, "lock"));
  return { locked: pid !== undefined, pid };
}

export const linux: Platform = {
  installCandidates() {
    return linuxInstallCandidates();
  },

  candidateFromPath(path) {
    const launcher = statSync(path, { throwIfNoEntry: false })?.isDirectory() ? join(path, "firefox") : path;
    return resolveLauncher(launcher);
  },

  profileRoots() {
    const home = homedir();
    const flatpak = join(home, ".var", "app", "org.mozilla.firefox");
    // Both native roots can exist when an older and a newer Firefox share a machine.
    return [
      join(home, ".mozilla", "firefox"),
      join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "mozilla", "firefox"),
      join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
      join(flatpak, ".mozilla", "firefox"),
      join(flatpak, "config", "mozilla", "firefox"),
    ];
  },

  profileSetup(install) {
    const sandbox = sandboxOf(install.installDir);
    return {
      roots: [linuxProfileRoot(install.installDir, homedir(), process.env)],
      hashDir: sandbox === "flatpak" ? FLATPAK_SANDBOX_DIR : install.installDir,
      // The snap runs with legacy profiles and never writes [Install…] sections.
      legacy: sandbox === "snap",
    };
  },

  profileLocked(profilePath) {
    return lockState(profilePath).locked;
  },

  lockHolder(profilePath) {
    const pid = lockState(profilePath).pid;
    if (pid === undefined) return undefined;
    // Sandboxed Firefox (Flatpak) reports its path inside the sandbox.
    let exe: string | undefined;
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      exe = undefined;
    }
    return { pid, exe };
  },

  requestQuit(pid) {
    // Firefox's GTK shell turns SIGTERM into a normal quit.
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  },

  visibleLaunchArgs() {
    return [];
  },
};
