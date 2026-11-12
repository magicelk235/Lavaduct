// Loads a manifest into a real Firefox, headless and on a throwaway profile, to
// check whether Firefox accepts it and what it makes of it. Not a test file itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { startPrivilegedFirefox } from "./firefox-devtools.js";

/** The Firefox the tests load into, or undefined when none is installed. */
export const firefox = selectFirefox(findFirefoxInstalls());

/**
 * Install `manifest` (plus `files`, path → contents) as a temporary add-on, then
 * resolve with `inspect({ chrome, id })`, where `chrome(js)` runs `js` in Firefox's
 * parent process. Rejects with Firefox's refusal when the add-on doesn't load.
 */
export async function loadAddon(manifest, files, inspect) {
  return withAddonDir(manifest, files, async (ext, profile) => {
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      const id = await ff.installAddon(ext);
      return await inspect({ chrome: ff.chrome, id });
    } finally {
      await ff.close();
    }
  });
}

/**
 * Read `manifest` (plus `files`) the way Firefox reads a signed or unsigned
 * install rather than a temporary one, and resolve with what Firefox made of it:
 * `{ errors, warnings, manifest }`. Firefox lets a few values through only for
 * temporary loads, which `loadAddon` can't show.
 */
export async function firefoxInstalledManifest(manifest, files = {}) {
  return withAddonDir(manifest, files, async (ext, profile) => {
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      return JSON.parse(
        await ff.chrome(`(async () => {
          const { ExtensionData } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
          const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
          const rootURI = Services.io.newURI(Services.io.newFileURI(new FileUtils.File(${JSON.stringify(ext)})).spec.replace(/\\/?$/, "/"));
          const data = await ExtensionData.constructAsync({ rootURI, checkPrivileged: async () => false, temporarilyInstalled: false });
          await data.loadManifest();
          return JSON.stringify({ errors: data.errors, warnings: data.warnings, manifest: data.manifest });
        })()`),
      );
    } finally {
      await ff.close();
    }
  });
}

async function withAddonDir(manifest, files, use) {
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
    return await use(ext, profile);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Firefox's refusal message for `manifest`, or null when it loads. */
export async function firefoxRefusal(manifest, files = {}) {
  try {
    await loadAddon(manifest, files, () => {});
    return null;
  } catch (e) {
    return e.message;
  }
}
