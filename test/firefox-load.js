// Loads a manifest into a real Firefox, headless and on a throwaway profile, to
// check whether Firefox accepts it. Not a test file itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { startPrivilegedFirefox } from "./firefox-devtools.js";

/** The Firefox the tests load into, or undefined when none is installed. */
export const firefox = selectFirefox(findFirefoxInstalls());

/**
 * Install `manifest` (plus `files`, path → contents) as a temporary add-on and
 * resolve with Firefox's refusal message, or null when it loads.
 */
export async function firefoxRefusal(manifest, files = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "lavaduct-load-"));
  try {
    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(ext, path)), { recursive: true });
      writeFileSync(join(ext, path), text);
    }
    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      await ff.installAddon(ext);
      return null;
    } catch (e) {
      return e.message;
    } finally {
      await ff.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
