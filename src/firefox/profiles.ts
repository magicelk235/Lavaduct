import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEDICATED_PROFILE } from "../name.js";
import { stateDir } from "../state.js";
import { installHash } from "./cityhash.js";
import type { FirefoxInstall } from "./locate.js";
import { platform } from "./platform/index.js";
import { pathKey, realPath } from "./platform/shared.js";

export interface FirefoxProfile {
  /** Name in profiles.ini; absent for directories Firefox doesn't list. */
  name?: string;
  path: string;
  isDefault: boolean;
}

/** A `[ProfileN]` section of profiles.ini. */
export interface ProfileEntry {
  name: string;
  /** `Path=` as written; install sections refer to profiles by this string. */
  descriptor: string;
  isRelative: boolean;
  /** The profile directory. */
  path: string;
  /** `Default=1`, the default in legacy mode (snap, or Firefox before 67). */
  legacyDefault: boolean;
}

export interface ProfilesIni {
  profiles: ProfileEntry[];
  /** Install hash → descriptor of that install's default profile. */
  installDefaults: Map<string, string>;
}

function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      const name = header[1].trim();
      current = sections.get(name) ?? new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    const eq = line.indexOf("=");
    if (current && eq > 0) current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return sections;
}

/**
 * Read profiles.ini (and installs.ini, its backup of the install sections)
 * the way Firefox does. `root` is the directory holding them; relative
 * profile paths are resolved against it.
 */
export function parseProfilesIni(text: string, root: string, installsIni?: string): ProfilesIni {
  const ini = parseIni(text);
  const installDefaults = new Map<string, string>();
  for (const [section, values] of ini) {
    const descriptor = values.get("Default");
    if (section.startsWith("Install") && descriptor !== undefined) installDefaults.set(section.slice(7), descriptor);
  }
  // A profiles.ini without [General] Version was rewritten by Firefox older
  // than 67, which drops the install sections; Firefox restores them from
  // installs.ini, where the sections lack the "Install" prefix.
  if (installsIni !== undefined && !ini.get("General")?.has("Version")) {
    for (const [hash, values] of parseIni(installsIni)) {
      const descriptor = values.get("Default");
      if (descriptor !== undefined) installDefaults.set(hash, descriptor);
    }
  }

  const profiles: ProfileEntry[] = [];
  // Firefox reads Profile0, Profile1, … and stops at the first section
  // without IsRelative; entries missing Path or Name are skipped.
  for (let i = 0; ; i++) {
    const section = ini.get(`Profile${i}`);
    const isRelative = section?.get("IsRelative");
    if (!section || isRelative === undefined) break;
    const descriptor = section.get("Path");
    const name = section.get("Name");
    if (descriptor === undefined || name === undefined) continue;
    const relative = isRelative === "1";
    profiles.push({
      name,
      descriptor,
      isRelative: relative,
      path: relative ? join(root, descriptor) : descriptor,
      legacyDefault: section.get("Default") === "1",
    });
  }
  return { profiles, installDefaults };
}

/**
 * The profile an install opens when started without a profile flag. Installs
 * since Firefox 67 keep their own default in `[Install<hash>]`; legacy mode
 * (the snap, or a profiles.ini with no install sections) uses `Default=1`, or
 * the only profile there is. Undefined when the install hasn't run yet.
 */
export function pickDefaultProfile(
  ini: ProfilesIni,
  install: { hash: string; legacy: boolean },
): ProfileEntry | undefined {
  if (install.legacy || ini.installDefaults.size === 0) {
    return ini.profiles.find((p) => p.legacyDefault) ?? (ini.profiles.length === 1 ? ini.profiles[0] : undefined);
  }
  const descriptor = ini.installDefaults.get(install.hash);
  return descriptor ? ini.profiles.find((p) => p.descriptor === descriptor) : undefined;
}

function readProfilesIni(root: string): ProfilesIni | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, "profiles.ini"), "utf-8");
  } catch {
    return undefined;
  }
  let installs: string | undefined;
  try {
    installs = readFileSync(join(root, "installs.ini"), "utf-8");
  } catch {
    installs = undefined;
  }
  return parseProfilesIni(text, root, installs);
}

/**
 * Profiles in every profile root on this machine. A profile counts as default
 * when some install (or, in legacy mode, the root) uses it by default.
 * Profiles that exist only in Firefox's newer profile groups aren't listed.
 */
export function listProfiles(): FirefoxProfile[] {
  const seen = new Set<string>();
  const out: FirefoxProfile[] = [];
  for (const root of platform.profileRoots()) {
    const key = pathKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    const ini = readProfilesIni(root);
    if (!ini) continue;
    const defaults = new Set(ini.installDefaults.values());
    const legacy = ini.installDefaults.size === 0 ? pickDefaultProfile(ini, { hash: "", legacy: true }) : undefined;
    for (const p of ini.profiles) {
      out.push({ name: p.name, path: p.path, isDefault: p === legacy || defaults.has(p.descriptor) });
    }
  }
  return out;
}

/** Profiles the install can open by name, with `isDefault` marking the one it starts with. */
export function profilesFor(install: FirefoxInstall): FirefoxProfile[] {
  const setup = platform.profileSetup(install);
  const hash = installHash(realPath(setup.hashDir));
  return setup.roots.flatMap((root) => {
    const ini = readProfilesIni(root);
    if (!ini) return [];
    const def = pickDefaultProfile(ini, { hash, legacy: setup.legacy });
    return ini.profiles.map((p) => ({ name: p.name, path: p.path, isDefault: p === def }));
  });
}

export function defaultProfileFor(install: FirefoxInstall): FirefoxProfile | undefined {
  return profilesFor(install).find((p) => p.isDefault);
}

/**
 * The profile `--profile` names: a directory path, a name from profiles.ini
 * (the install's own root first), or the dedicated profile's name. Without a
 * selector, the install's default profile.
 */
export function resolveProfile(selector: string | undefined, install: FirefoxInstall): FirefoxProfile {
  const own = profilesFor(install);
  if (selector === undefined) {
    const def = own.find((p) => p.isDefault);
    if (def) return def;
    throw new Error(
      `Firefox ${install.version} at ${install.installDir} has no default profile yet. ` +
        "Start that Firefox once so it creates one, or pass --profile <name|path>.",
    );
  }

  const isDir = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!/[\\/]/.test(selector)) {
    const named = own.find((p) => p.name === selector) ?? listProfiles().find((p) => p.name === selector);
    if (named) return { ...named, isDefault: own.includes(named) && named.isDefault };
    if (selector === DEDICATED_PROFILE) return dedicatedProfile();
    if (!isDir(selector)) {
      throw new Error(
        `No Firefox profile named "${selector}". Run --doctor to list profiles, or pass a profile directory.`,
      );
    }
  }

  const dir = resolve(selector);
  if (!isDir(dir)) {
    throw new Error(`No Firefox profile at ${dir}. Pass an existing profile directory, or a profile name from --doctor.`);
  }
  const key = pathKey(dir);
  const known = own.find((p) => pathKey(p.path) === key) ?? listProfiles().find((p) => pathKey(p.path) === key);
  if (!known) return { path: dir, isDefault: false };
  return { ...known, isDefault: own.includes(known) && known.isDefault };
}

/** Whether a running Firefox has the profile open. */
export function profileInUse(profilePath: string): boolean {
  return platform.profileLocked(profilePath);
}

/**
 * The profile the temporary route uses unless told otherwise, kept apart from
 * the user's own profiles so they never run under remote control.
 */
export function dedicatedProfile(): FirefoxProfile {
  const path = join(stateDir(), "profiles", DEDICATED_PROFILE);
  mkdirSync(path, { recursive: true });
  return { path, isDefault: false };
}
