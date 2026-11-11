// Chrome reads _locales/*/messages.json with its JSON extensions: /* */ comments,
// raw line breaks inside strings and \x escapes. Firefox strips only // comments
// before JSON.parse, and refuses the whole add-on when any catalog, not only the
// default locale's, fails: "Loading locale file _locales/de/messages.json: Error:
// Invalid JSON: Unexpected /".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLocaleCatalogs } from "../dist/input/stage.js";
import { parseJsonc } from "../dist/manifest/manifest.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const CATALOGS = {
  en: '/* Chrome takes block comments */\n{\n  "name": { "message": "Catalog" },\n  "line": { "message": "two\nlines" },\n  "hex": { "message": "\\x41BC" }\n}\n',
  de: '{ "name": { "message": "Katalog" /* inline */ } }',
  // Firefox reads these as they are; they stay byte for byte.
  fr: '\ufeff// a line comment\n{ "name": { "message": "Catalogue" } }',
  es: '{ "name": { "message": "Catálogo", "description": "a // in a string" } }',
};

function stagedCatalogs(t) {
  const dir = mkdtempSync(join(tmpdir(), "stage-locales-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [locale, text] of Object.entries(CATALOGS)) {
    mkdirSync(join(dir, "_locales", locale), { recursive: true });
    writeFileSync(join(dir, "_locales", locale, "messages.json"), text);
  }
  return dir;
}

const read = (dir, locale) => readFileSync(join(dir, "_locales", locale, "messages.json"), "utf-8");

test("parseJsonc reads Chrome's line breaks in strings and \\x escapes", () => {
  assert.deepEqual(parseJsonc(CATALOGS.en), { name: { message: "Catalog" }, line: { message: "two\nlines" }, hex: { message: "ABC" } });
});

test("catalogs Firefox can't parse are rewritten as plain JSON, the rest left alone", (t) => {
  const dir = stagedCatalogs(t);
  assert.deepEqual(normalizeLocaleCatalogs(dir).sort(), ["_locales/de/messages.json", "_locales/en/messages.json"]);
  assert.deepEqual(JSON.parse(read(dir, "en")), { name: { message: "Catalog" }, line: { message: "two\nlines" }, hex: { message: "ABC" } });
  assert.deepEqual(JSON.parse(read(dir, "de")), { name: { message: "Katalog" } });
  assert.equal(read(dir, "fr"), CATALOGS.fr);
  assert.equal(read(dir, "es"), CATALOGS.es);
});

test("Firefox loads the add-on with the rewritten catalogs", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  const dir = stagedCatalogs(t);
  const manifest = { manifest_version: 3, name: "__MSG_name__", version: "1", default_locale: "en" };
  const files = () => Object.fromEntries(Object.keys(CATALOGS).map((l) => [`_locales/${l}/messages.json`, read(dir, l)]));
  assert.match(await firefoxRefusal(manifest, files()), /Loading locale file _locales\/(en|de)\/messages\.json/, "the unconverted catalogs load; the test proves nothing");
  normalizeLocaleCatalogs(dir);
  assert.equal(await firefoxRefusal(manifest, files()), null);
});
