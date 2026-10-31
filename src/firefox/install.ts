import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CHROME_STATIC_RULE_LIMIT, STATIC_RULES_PREF } from "../manifest/dnr.js";
import { readState, writeState } from "../state.js";
import type { SignRoute } from "../types.js";
import { readInstalledAddons } from "./extensions-json.js";
import { pathKey } from "./platform/shared.js";

// A line of user.js or prefs.js that sets a pref, and the pref's name.
const PREF_LINE_RE = /^\s*(?:user_|sticky_)?pref\(\s*["']([^"']+)["']/;

/**
 * Prefs Firefox checks before it starts its devtools server, the one the
 * temporary route loads add-ons through.
 */
export const DEBUGGER_SERVER_PREFS: Readonly<Record<string, boolean>> = {
  "devtools.debugger.remote-enabled": true,
  "devtools.chrome.enabled": true,
  // Otherwise each connection waits for the user to accept it in a dialog.
  "devtools.debugger.prompt-connection": false,
  // The default: a server on a TCP port (Windows) listens on loopback only.
  "devtools.debugger.force-local": true,
};

/**
 * Set prefs in the profile's user.js, replacing any line that already sets one
 * of them and keeping the rest. Firefox reads user.js at startup, so `changed`
 * means a running Firefox needs a restart to pick them up.
 */
export function setUserPrefs(profilePath: string, prefs: Readonly<Record<string, boolean | number>>): { changed: boolean } {
  const file = join(profilePath, "user.js");
  let before = "";
  try {
    before = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const lines = before ? before.split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();

  const placed = new Set<string>();
  const kept = lines.flatMap((line) => {
    const name = PREF_LINE_RE.exec(line)?.[1];
    if (name === undefined || !Object.hasOwn(prefs, name)) return [line];
    if (placed.has(name)) return [];
    placed.add(name);
    return [`user_pref(${JSON.stringify(name)}, ${prefs[name]});`];
  });
  for (const [name, value] of Object.entries(prefs)) {
    if (!placed.has(name)) kept.push(`user_pref(${JSON.stringify(name)}, ${value});`);
  }

  const after = kept.join(eol) + eol;
  if (after === before) return { changed: false };
  writeFileSync(file, after);
  return { changed: true };
}

/**
 * Turn off add-on signature enforcement in a profile through its user.js;
 * `changed` means a running Firefox needs a restart to pick that up. Release
 * and Beta builds ignore the pref.
 */
export function allowUnsignedInProfile(profilePath: string): { changed: boolean } {
  return setUserPrefs(profilePath, { "xpinstall.signatures.required": false });
}

/**
 * Let Firefox start its devtools server on the profile, through its user.js.
 * The server itself only starts when Firefox is launched with
 * --start-debugger-server, and only listens until Firefox quits.
 */
export function enableDebuggerServerInProfile(profilePath: string): { changed: boolean } {
  return setUserPrefs(profilePath, DEBUGGER_SERVER_PREFS);
}

/** A numeric pref as the profile's user.js or prefs.js sets it, user.js first. */
function numericPref(profilePath: string, name: string): number | undefined {
  for (const file of ["user.js", "prefs.js"]) {
    let text: string;
    try {
      text = readFileSync(join(profilePath, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (PREF_LINE_RE.exec(line)?.[1] !== name) continue;
      const value = /,\s*(-?\d+)\s*\)/.exec(line)?.[1];
      if (value !== undefined) return Number(value);
    }
  }
  return undefined;
}

/**
 * Give add-ons in the profile Chrome's room for static declarativeNetRequest
 * rules, through its user.js. A higher value the profile already has stays.
 */
export function raiseStaticRuleLimitInProfile(profilePath: string): { changed: boolean } {
  const current = numericPref(profilePath, STATIC_RULES_PREF);
  if (current !== undefined && current >= CHROME_STATIC_RULE_LIMIT) return { changed: false };
  return setUserPrefs(profilePath, { [STATIC_RULES_PREF]: CHROME_STATIC_RULE_LIMIT });
}

/**
 * Poll the profile's extensions.json until the add-on is installed, enabled
 * and at `version`. False when that doesn't happen within `timeoutMs`.
 */
export async function waitForAddon(
  profilePath: string,
  id: string,
  version: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ready = false;
    try {
      ready = readInstalledAddons(profilePath).some(
        (a) => a.id === id && a.version === version && a.active && !a.userDisabled,
      );
    } catch {
      // Unreadable for a moment; try again on the next poll.
    }
    if (ready) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(500, left));
  }
}

export interface InstallRecord {
  id: string;
  name: string;
  version: string;
  profilePath: string;
  route: SignRoute;
  /** ISO 8601 timestamp. */
  installedAt: string;
}

const INSTALLS_FILE = "installs.json";

/** Recorded installs other than the one of add-on `id` in the profile at `profilePath`. */
function otherInstalls(id: string, profilePath: string): InstallRecord[] {
  const key = pathKey(profilePath);
  return recordedInstalls().filter((r) => r.id !== id || pathKey(r.profilePath) !== key);
}

/** Remember an install so --list can mark the add-ons this tool put there. */
export function recordInstall(rec: InstallRecord): void {
  writeState(INSTALLS_FILE, [...otherInstalls(rec.id, rec.profilePath), rec]);
}

/** Forget the install of add-on `id` in a profile, e.g. once it has been uninstalled there. */
export function removeInstallRecord(id: string, profilePath: string): void {
  const before = recordedInstalls().length;
  const kept = otherInstalls(id, profilePath);
  if (kept.length !== before) writeState(INSTALLS_FILE, kept);
}

/** Installs recorded so far, oldest first; one per add-on ID and profile. */
export function recordedInstalls(): InstallRecord[] {
  const data = readState<unknown>(INSTALLS_FILE, []);
  if (!Array.isArray(data)) return [];
  return data.filter(
    (r): r is InstallRecord =>
      !!r && typeof r === "object" && typeof r.id === "string" && typeof r.profilePath === "string",
  );
}
