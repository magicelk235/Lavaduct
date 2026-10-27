import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADDON_ID_SUFFIX } from "../name.js";
import { readState, stateDir } from "../state.js";

const SALT_FILE = "addon-id-salt.json";

// AMO's rules for gecko IDs: a {UUID} or an email-like name, at most 80 characters.
const MAX_ADDON_ID_LENGTH = 80;
const AMO_ADDON_ID_RE =
  /^(\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}|[A-Za-z0-9._-]*@[A-Za-z0-9._-]+)$/;

/** True when AMO accepts `id` as an add-on ID. */
export function isAmoAddonId(id: string): boolean {
  return id.length <= MAX_ADDON_ID_LENGTH && AMO_ADDON_ID_RE.test(id);
}

// Every ID derived on this machine embeds the salt, so once written it must never
// change. The exclusive create keeps a concurrent first run from replacing a salt
// another run already handed out, and a damaged file is an error rather than a
// silent new salt.
function addonIdSalt(): string {
  const path = join(stateDir(), SALT_FILE);
  if (!existsSync(path)) {
    mkdirSync(stateDir(), { recursive: true });
    try {
      writeFileSync(path, JSON.stringify({ salt: randomBytes(4).toString("hex") }, null, 2) + "\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const salt = readState<{ salt?: unknown } | null>(SALT_FILE, null)?.salt;
  if (typeof salt === "string" && /^[0-9a-f]{8}$/.test(salt)) return salt;
  throw new Error(
    `${path} doesn't hold a valid add-on ID salt. Restore it from a backup to keep your add-on IDs, or delete it to start over with new ones.`,
  );
}

/**
 * The add-on ID used when --addon-id isn't given: `<chromeId>.<salt>@<ADDON_ID_SUFFIX>`.
 * AMO IDs belong to whoever submits them first, so the per-user salt keeps two users
 * converting the same extension from colliding, while one user always gets the same
 * ID for the same extension and updates replace the installed add-on.
 */
export function deriveAddonId(source: { chromeId?: string; name: string }): string {
  // Local inputs get an ID the way Chrome makes one from a key: the first 128 bits
  // of a SHA-256, written with the letters a-p instead of hex digits.
  const stem =
    source.chromeId ||
    [...createHash("sha256").update(source.name).digest("hex").slice(0, 32)]
      .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
      .join("");
  const id = `${stem}.${addonIdSalt()}@${ADDON_ID_SUFFIX}`;
  if (id.length > MAX_ADDON_ID_LENGTH || !/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(
      `The derived add-on ID "${id}" isn't one AMO accepts (at most ${MAX_ADDON_ID_LENGTH} letters, digits, ".", "_" or "-" around one "@"). Pass --addon-id instead.`,
    );
  }
  return id;
}
