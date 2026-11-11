// Chrome takes an http:// search engine URL. Firefox only takes https:// (or
// http://localhost) for search_url and suggest_url, and refuses the whole manifest
// otherwise. Nothing can fix that without guessing the engine serves https, so the
// analyzer blocks instead of letting the conversion produce an add-on Firefox
// won't load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { countBlocking } from "../dist/analyze/report.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const manifest = (provider) => ({
  manifest_version: 3,
  name: "Search",
  version: "1.0",
  browser_specific_settings: { gecko: { id: "search@example.com" } },
  chrome_settings_overrides: { search_provider: { name: "Example", keyword: "ex", encoding: "UTF-8", is_default: true, ...provider } },
});
const analyze = (provider) => analyzeManifest(manifest(provider), { minFirefox: DEFAULT_MIN_FIREFOX }).issues;

test("an http search or suggestion URL blocks the conversion", () => {
  for (const key of ["search_url", "suggest_url"]) {
    const issues = analyze({ search_url: "https://example.com/?q={searchTerms}", [key]: "http://example.com/?q={searchTerms}" });
    assert.equal(countBlocking(issues), 1, key);
    assert.ok(issues.some((i) => i.severity === "error" && i.message.includes(key)), key);
  }
});

test("https, localhost and an empty suggestion URL pass", () => {
  assert.equal(countBlocking(analyze({ search_url: "https://example.com/?q={searchTerms}", suggest_url: "" })), 0);
  assert.equal(countBlocking(analyze({ search_url: "http://localhost:8080/?q={searchTerms}" })), 0);
  assert.equal(countBlocking(analyze({ search_url: "http://127.0.0.1/?q={searchTerms}" })), 0);
  // Firefox checks the localized value, which only the locale files know.
  assert.equal(countBlocking(analyze({ search_url: "__MSG_searchUrl__" })), 0);
});

test("Firefox refuses the http URL and takes the https one", { skip: firefox ? false : "no Firefox install found", timeout: 240_000 }, async () => {
  assert.match(await firefoxRefusal(manifest({ search_url: "http://example.com/?q={searchTerms}" })), /search_url/);
  assert.equal(await firefoxRefusal(manifest({ search_url: "https://example.com/?q={searchTerms}" })), null);
});
