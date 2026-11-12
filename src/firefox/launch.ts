import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { warn } from "../util.js";
import type { FirefoxInstall } from "./locate.js";
import { platform, type LockHolder, type ProfileLookup } from "./platform/index.js";
import { pathKey, processAlive } from "./platform/shared.js";
import { defaultProfileFor, profileInUse, profilesFor, type FirefoxProfile } from "./profiles.js";

const QUIT_TIMEOUT_MS = 30_000;

/**
 * Start Firefox. A visible Firefox is detached so it outlives this process; a
 * headless one stays attached, so stopping this process stops it too. With
 * `background`, a Firefox that the command line is handed to stays where it is
 * instead of coming to the front.
 */
export function launchFirefox(
  install: FirefoxInstall,
  args: string[],
  opts: { headless?: boolean; background?: boolean } = {},
): ChildProcess {
  if (!existsSync(install.binary)) throw new Error(`Firefox isn't at ${install.binary} any more.`);
  const headless = opts.headless === true;
  const extra = headless ? ["--headless"] : opts.background ? [] : platform.visibleLaunchArgs();
  const child = spawn(install.binary, [...extra, ...args], {
    detached: !headless,
    stdio: "ignore",
  });
  child.once("error", (err) => warn(`Couldn't start ${install.binary}: ${err.message}`));
  if (!headless) child.unref();
  return child;
}

/**
 * Finds which running Firefox has a profile open. On Windows that comes from
 * command lines, which name a profile by path, by name, or not at all (the
 * install's default).
 */
function holderOf(install: FirefoxInstall, profilePath: string): LockHolder | undefined {
  const lookup: ProfileLookup = {
    pathForName: (name) => profilesFor(install).find((p) => p.name === name)?.path,
    defaultForBinary: (binary) => defaultProfileFor({ ...install, binary, installDir: dirname(binary) })?.path,
  };
  return platform.lockHolder(profilePath, lookup);
}

/**
 * Wait until the Firefox that has the profile open is old enough to take
 * requests (platform.quitMinAgeMs); a younger one may drop them. Returns the
 * lock holder, or undefined when it can't be told.
 */
export async function waitForSettledFirefox(install: FirefoxInstall, profilePath: string): Promise<LockHolder | undefined> {
  const holder = holderOf(install, profilePath);
  if (holder && platform.quitMinAgeMs > 0) {
    const age = platform.processAgeMs(holder.pid);
    if (age !== undefined && age < platform.quitMinAgeMs) await sleep(platform.quitMinAgeMs - age);
  }
  return holder;
}

/**
 * Whether the Firefox that has the profile open started before the profile's
 * user.js was last written. Firefox reads user.js only when it starts, so that
 * Firefox hasn't seen what the file says now. False when no Firefox has the
 * profile open, there is no user.js, or the process's start can't be told.
 */
export function startedBeforeUserJs(install: FirefoxInstall, profilePath: string): boolean {
  const written = statSync(join(profilePath, "user.js"), { throwIfNoEntry: false })?.mtimeMs;
  if (written === undefined || !profileInUse(profilePath)) return false;
  const holder = holderOf(install, profilePath);
  const age = holder && platform.processAgeMs(holder.pid);
  // ps rounds the age down to whole seconds, which puts the start late: a
  // user.js written in the second Firefox started counts as read.
  return age !== undefined && written > Date.now() - age;
}

/**
 * Quit the Firefox that has the profile open, the way the user would, and wait
 * up to 30 s for it to let go of the profile. True when the profile is free
 * (including when nothing had it open); false when the quit couldn't be
 * requested or Firefox is still running, e.g. waiting on a "close tabs?" prompt.
 */
export async function quitFirefoxForProfile(install: FirefoxInstall, profilePath: string): Promise<boolean> {
  if (!profileInUse(profilePath)) return true;
  const holder = await waitForSettledFirefox(install, profilePath);
  if (!holder) return false;
  if (!platform.requestQuit(holder.pid)) return false;

  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    // Wait for the process too: until it's gone it may still take commands
    // forwarded from a new launch.
    if (!profileInUse(profilePath) && !processAlive(holder.pid)) return true;
  }
  return !profileInUse(profilePath);
}

/**
 * The executable of the Firefox that has the profile open, when it comes from
 * another install than `install`. Undefined when no Firefox has the profile
 * open, it is this install's, or the holder can't be told.
 */
export function otherInstallHolding(install: FirefoxInstall, profilePath: string): string | undefined {
  if (!profileInUse(profilePath)) return undefined;
  const exe = holderOf(install, profilePath)?.exe;
  const dirs = [install.installDir, platform.profileSetup(install).hashDir].map(pathKey);
  return exe && !dirs.includes(pathKey(dirname(exe))) ? exe : undefined;
}

/**
 * Hand an .xpi to Firefox, which shows its install prompt. If Firefox already
 * has the profile open, the new process forwards the request to it and
 * exits. Forwarding matches on the profile path as the running Firefox
 * spelled it, so a registered profile is passed by name like a normal start.
 * The .xpi path must be absolute: macOS forwards no working directory.
 *
 * Throws when a Firefox from another install has the profile open: it can't
 * take the request over, and the new process would end on Firefox's "already
 * running" dialog.
 */
export function openXpiInFirefox(install: FirefoxInstall, profile: FirefoxProfile, xpiPath: string): void {
  const exe = otherInstallHolding(install, profile.path);
  if (exe) {
    throw new Error(`${profile.path} is open in the Firefox at ${exe}. Quit that Firefox first, or pass --firefox "${exe}".`);
  }
  openProfileInFirefox(install, profile, [resolve(xpiPath)]);
}

/**
 * Start Firefox on a profile the way the user would: by name when the
 * install has it registered, so a running Firefox that has it open takes the
 * request over, else by path.
 */
export function openProfileInFirefox(
  install: FirefoxInstall,
  profile: FirefoxProfile,
  args: string[] = [],
  opts: { background?: boolean } = {},
): void {
  const own = profilesFor(install);
  const key = pathKey(profile.path);
  const registered = own.find((p) => pathKey(p.path) === key);
  const name = registered?.name;
  // -P picks the first profile with that name.
  const byName = name !== undefined && own.find((p) => p.name === name) === registered;
  const profileArgs = byName ? ["-P", name] : ["--profile", resolve(profile.path)];
  launchFirefox(install, [...profileArgs, ...args], opts);
}
