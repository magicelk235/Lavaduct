// Chrome on macOS and Windows reads an extension from a case-insensitive disk, so a
// manifest naming "icons/a.png" finds Icons/A.png. Firefox reads a packed .xpi by
// exact name: the icon, the content script or the page isn't there (a fetch of
// moz-extension://…/icons/a.png fails), on every OS. The temporary route loads the
// folder, which hides it on macOS and Windows; the amo and unsigned routes install
// the .xpi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { matchManifestPathCase } from "../dist/input/stage.js";
import { zipDirectory } from "../dist/zip/write.js";
import { firefox } from "./firefox-load.js";
import { startPrivilegedFirefox } from "./firefox-devtools.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function staged(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "stage-path-case-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), data);
  }
  return dir;
}

const manifest = () => ({
  manifest_version: 3,
  name: "Cases",
  version: "1",
  icons: { 48: "icons/a.png" },
  action: { default_popup: "./popup/Popup.html#compact" },
  content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js", "exact.js"] }],
  web_accessible_resources: [{ resources: ["Assets/*", "assets/logo.png"], matches: ["<all_urls>"] }],
  options_page: "missing.html",
  browser_specific_settings: { gecko: { id: "cases@lavaduct" } },
});

test("manifest paths take the case of the files on disk", (t) => {
  const dir = staged(t, {
    "Icons/A.png": PNG,
    "popup/popup.html": "<p>",
    "Content.js": "",
    "exact.js": "",
    "assets/Logo.png": PNG,
  });
  const m = manifest();
  const changes = matchManifestPathCase(dir, m);
  assert.deepEqual(m.icons, { 48: "Icons/A.png" });
  assert.equal(m.action.default_popup, "./popup/popup.html#compact");
  assert.deepEqual(m.content_scripts[0].js, ["Content.js", "exact.js"]);
  assert.deepEqual(m.web_accessible_resources[0].resources, ["Assets/*", "assets/Logo.png"]);
  assert.equal(m.options_page, "missing.html");
  assert.equal(changes.length, 4, changes.join("\n"));
});

test("Firefox finds the icon and the content script in the packed add-on", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  const dir = staged(t, { "Icons/A.png": PNG, "Content.js": "", "popup/popup.html": "<p>", "exact.js": "", "assets/Logo.png": PNG });
  const scratch = staged(t, {});
  const probe = async (m, name) => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    const xpi = join(scratch, `${name}.xpi`);
    zipDirectory(dir, xpi);
    const profile = join(scratch, `profile-${name}`);
    mkdirSync(profile);
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      const id = await ff.installAddon(xpi);
      return JSON.parse(
        await ff.chrome(`(async () => {
          const policy = WebExtensionPolicy.getByID(${JSON.stringify(id)});
          const m = policy.extension.manifest;
          const ok = async (p) => { try { return (await fetch(policy.getURL(p))).ok; } catch { return false; } };
          return JSON.stringify({ icon: await ok(m.icons[48]), script: await ok(m.content_scripts[0].js[0]) });
        })()`),
      );
    } finally {
      await ff.close();
    }
  };
  assert.deepEqual(await probe(manifest(), "as-written"), { icon: false, script: false }, "Firefox found the files as written; the test proves nothing");
  const fixed = manifest();
  matchManifestPathCase(dir, fixed);
  assert.deepEqual(await probe(fixed, "matched"), { icon: true, script: true });
});
