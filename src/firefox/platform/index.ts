import type { FirefoxInstall } from "../locate.js";
import { darwin } from "./darwin.js";
import { linux } from "./linux.js";
import { win32 } from "./win32.js";

/** Linux packages that run Firefox in a sandbox with its own view of the home directory. */
export type Sandbox = "snap" | "flatpak";

/** A Firefox binary found on disk, before its build constants are read. */
export interface InstallCandidate {
  /** What to start: the binary itself, or the launcher a package manager put on PATH. */
  binary: string;
  /** Directory holding omni.ja and the real binary, as this process sees it. */
  installDir: string;
  sandbox?: Sandbox;
}

/** Where an install keeps its profiles and how it picks its default one. */
export interface ProfileSetup {
  /** Directories holding the profiles.ini this install reads. */
  roots: string[];
  /** Directory whose CityHash names the install's `[Install…]` section. */
  hashDir: string;
  /** Legacy mode: no `[Install…]` sections; the default is the `Default=1` profile. */
  legacy: boolean;
}

/** Profile lookups the Windows lock-holder search needs. */
export interface ProfileLookup {
  /** Directory of the registered profile with this name. */
  pathForName(name: string): string | undefined;
  /** Directory of the default profile of the install whose binary this is. */
  defaultForBinary(binary: string): string | undefined;
}

export interface LockHolder {
  pid: number;
  /** Path of the running binary, as that process sees it. */
  exe?: string;
}

/** Everything that differs between macOS, Windows and Linux. */
export interface Platform {
  /** Firefox installs in the places this OS keeps them, most likely first. */
  installCandidates(): InstallCandidate[];
  /** An install from a user-supplied path: a binary, its directory, or a macOS .app. */
  candidateFromPath(path: string): InstallCandidate | undefined;
  /** Every directory that may hold a profiles.ini. */
  profileRoots(): string[];
  profileSetup(install: FirefoxInstall): ProfileSetup;
  /** Whether a running Firefox holds the profile's lock. */
  profileLocked(profilePath: string): boolean;
  /** The Firefox process holding the profile's lock and its executable, when they can be told. */
  lockHolder(profilePath: string, lookup: ProfileLookup): LockHolder | undefined;
  /** Ask a Firefox process to quit the way the user would. False if the request couldn't be sent. */
  requestQuit(pid: number): boolean;
  /**
   * How old a Firefox process must be before a quit request reaches it. A
   * younger one may drop the request and then ignore every later one.
   */
  quitMinAgeMs: number;
  /** Extra arguments for a Firefox the user will see. */
  visibleLaunchArgs(): string[];
}

export const platform: Platform =
  process.platform === "win32" ? win32 : process.platform === "darwin" ? darwin : linux;
