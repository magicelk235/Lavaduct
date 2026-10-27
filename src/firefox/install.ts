import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readState, writeState } from "../state.js";
import type { SignRoute } from "../types.js";
import { readInstalledAddons } from "./extensions-json.js";
import { pathKey } from "./platform/shared.js";

const SIGNATURE_PREF_LINE = 'user_pref("xpinstall.signatures.required", false);';
const SIGNATURE_PREF_RE = /^\s*(?:user_|sticky_)?pref\(\s*["']xpinstall\.signatures\.required["']/;

/**
 * Turn off add-on signature enforcement in a profile through its user.js,
 * replacing any line that already sets the pref. Firefox reads user.js at
 * startup, so `changed` means a running Firefox needs a restart to pick it up.
 * Release and Beta builds ignore the pref.
 */
export function allowUnsignedInProfile(profilePath: string): { changed: boolean } {
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

  let placed = false;
  const kept = lines.flatMap((line) => {
    if (!SIGNATURE_PREF_RE.test(line)) return [line];
    if (placed) return [];
    placed = true;
    return [SIGNATURE_PREF_LINE];
  });
  if (!placed) kept.push(SIGNATURE_PREF_LINE);

  const after = kept.join(eol) + eol;
  if (after === before) return { changed: false };
  writeFileSync(file, after);
  return { changed: true };
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
