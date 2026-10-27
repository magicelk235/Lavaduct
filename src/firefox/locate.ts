import { readAppConstants } from "./appconstants.js";
import { platform, type InstallCandidate } from "./platform/index.js";
import { pathKey } from "./platform/shared.js";

export interface FirefoxInstall {
  /** What to start: firefox, firefox.exe, or the launcher a package manager installed. */
  binary: string;
  /** Directory of the real binary and omni.ja (`Contents/MacOS` on macOS). */
  installDir: string;
  /** Update channel, for display: release, beta, aurora, nightly, esr or default. */
  channel: string;
  version: string;
  /** Release and Beta builds ignore xpinstall.signatures.required. */
  requireSigning: boolean;
}

// Names people use for channels, mapped to MOZ_UPDATE_CHANNEL values.
const CHANNEL_ALIASES: Record<string, string> = {
  stable: "release",
  dev: "aurora",
  devedition: "aurora",
  developer: "aurora",
  "developer-edition": "aurora",
};

function toInstall(candidate: InstallCandidate): FirefoxInstall | undefined {
  const constants = readAppConstants(candidate.installDir);
  return constants ? { ...candidate, ...constants } : undefined;
}

/** Every Firefox install on this machine that has readable build constants, most likely first. */
export function findFirefoxInstalls(): FirefoxInstall[] {
  const seen = new Set<string>();
  const installs: FirefoxInstall[] = [];
  for (const candidate of platform.installCandidates()) {
    const key = pathKey(candidate.installDir);
    if (seen.has(key)) continue;
    seen.add(key);
    const install = toInstall(candidate);
    if (install) installs.push(install);
  }
  return installs;
}

/**
 * Pick an install. `selector` is a channel name (release, beta, nightly, esr,
 * aurora or developer-edition) or a path to a binary, its directory or a
 * macOS .app; a path outside the discovered installs is accepted when it
 * holds a Firefox. Without a selector: the release channel, else the first
 * install found.
 */
export function selectFirefox(installs: FirefoxInstall[], selector?: string): FirefoxInstall | undefined {
  if (!selector) return installs.find((i) => i.channel === "release") ?? installs[0];

  const lowered = selector.toLowerCase();
  const channel = Object.hasOwn(CHANNEL_ALIASES, lowered) ? CHANNEL_ALIASES[lowered] : lowered;
  const byChannel = installs.find((i) => i.channel === channel);
  if (byChannel) return byChannel;
  const candidate = platform.candidateFromPath(selector);
  if (!candidate) return undefined;
  const key = pathKey(candidate.installDir);
  return installs.find((i) => pathKey(i.installDir) === key) ?? toInstall(candidate);
}
