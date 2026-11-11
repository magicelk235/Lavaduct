// Chrome skips a _locales subfolder whose name isn't one of its locales
// (extension_l10n_util ShouldSkipValidation), and refuses an extension whose locale
// folder has no readable messages.json, so the only such folders a working Chrome
// extension carries are junk it never looks at (_locales/xx/, an empty folder).
// Firefox reads every subfolder and refuses the whole add-on: "Loading locale file
// _locales/xx/messages.json: ... (NS_ERROR_FILE_NOT_FOUND)".
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeUnreadableLocales } from "../dist/input/stage.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

function staged(t) {
  const dir = mkdtempSync(join(tmpdir(), "stage-locale-junk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalogs = {
    en: '{ "name": { "message": "Junk" } }',
    de: '/* Chrome reads this */ { "name": { "message": "Müll" } }',
    yy: "not json",
  };
  for (const [locale, text] of Object.entries(catalogs)) {
    mkdirSync(join(dir, "_locales", locale), { recursive: true });
    writeFileSync(join(dir, "_locales", locale, "messages.json"), text);
  }
  mkdirSync(join(dir, "_locales", "xx"));
  writeFileSync(join(dir, "_locales", "xx", "notes.txt"), "no catalog here");
  return dir;
}

test("locale folders without a catalog Chrome reads are removed, the rest kept", (t) => {
  const dir = staged(t);
  assert.deepEqual(removeUnreadableLocales(dir, "en").sort(), ["_locales/xx", "_locales/yy"]);
  assert.deepEqual(readdirSync(join(dir, "_locales")).sort(), ["de", "en"]);
});

test("the default locale's folder is kept for the analyzer to report", (t) => {
  const dir = staged(t);
  assert.deepEqual(removeUnreadableLocales(dir, "xx").sort(), ["_locales/yy"]);
  assert.ok(existsSync(join(dir, "_locales", "xx")));
});

test("Firefox loads the add-on once the folders are gone", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  const dir = staged(t);
  rmSync(join(dir, "_locales", "de"), { recursive: true });
  rmSync(join(dir, "_locales", "yy"), { recursive: true });
  const manifest = { manifest_version: 3, name: "__MSG_name__", version: "1", default_locale: "en" };
  const files = () => {
    const out = {};
    for (const locale of readdirSync(join(dir, "_locales"))) {
      for (const name of readdirSync(join(dir, "_locales", locale))) out[`_locales/${locale}/${name}`] = readFileSync(join(dir, "_locales", locale, name));
    }
    return out;
  };
  assert.match(await firefoxRefusal(manifest, files()), /_locales\/xx\/messages\.json/, "Firefox took the junk folder; the test proves nothing");
  removeUnreadableLocales(dir, "en");
  assert.equal(await firefoxRefusal(manifest, files()), null);
});
