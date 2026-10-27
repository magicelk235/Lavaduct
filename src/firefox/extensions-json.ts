import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface InstalledAddon {
  id: string;
  name: string;
  version: string;
  active: boolean;
  userDisabled: boolean;
  type: string;
  /** Install location: app-profile for add-ons the user installed. */
  location: string;
}

interface RawAddon {
  id?: unknown;
  type?: unknown;
  version?: unknown;
  active?: unknown;
  userDisabled?: unknown;
  hidden?: unknown;
  location?: unknown;
  defaultLocale?: unknown;
}

/**
 * Extensions recorded in a profile's extensions.json, as about:addons lists
 * them: no themes, dictionaries or language packs, and none of Firefox's
 * hidden built-ins. Temporary add-ons are never written there. A profile
 * Firefox hasn't started yet has no file and no add-ons.
 */
export function readInstalledAddons(profilePath: string): InstalledAddon[] {
  const file = join(profilePath, "extensions.json");
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Can't read ${file}: ${(err as Error).message}`);
  }
  const addons: unknown = data && typeof data === "object" && "addons" in data ? data.addons : undefined;
  if (!Array.isArray(addons)) return [];
  return addons.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const a: RawAddon = entry;
    if (a.type !== "extension" || a.hidden === true || typeof a.id !== "string") return [];
    const locale = a.defaultLocale;
    const name = locale && typeof locale === "object" && "name" in locale ? locale.name : undefined;
    return [
      {
        id: a.id,
        name: typeof name === "string" && name ? name : a.id,
        version: typeof a.version === "string" ? a.version : "",
        active: a.active === true,
        userDisabled: a.userDisabled === true,
        type: a.type,
        location: typeof a.location === "string" ? a.location : "",
      },
    ];
  });
}
