// Firefox only lets add-ons replace the new tab page. Its schema marks
// chrome_url_overrides.history and .bookmarks unsupported, and an unsupported
// property makes it refuse the whole manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = (overrides) => ({ manifest_version: 3, name: "Overrides", version: "1.0", chrome_url_overrides: overrides });

test("history and bookmarks overrides are removed, the new tab page stays", () => {
  assert.deepEqual(
    transformManifest(manifest({ newtab: "tab.html", history: "history.html" }), [], options).chrome_url_overrides,
    { newtab: "tab.html" },
  );
  assert.equal("chrome_url_overrides" in transformManifest(manifest({ bookmarks: "marks.html" }), [], options), false);
});

test("the conversion report names the removed override", () => {
  const before = manifest({ newtab: "tab.html", history: "history.html" });
  assert.ok(summarizeManifestChanges(before, transformManifest(before, [], options)).some((c) => c.includes("`history`")));
});

test("the analyzer reports the removed override as auto-fixed", () => {
  const { issues } = analyzeManifest(manifest({ history: "history.html" }), { minFirefox: DEFAULT_MIN_FIREFOX });
  const [issue] = issues.filter((i) => i.message.includes("chrome_url_overrides.history"));
  assert.equal(issue.autoFixed, true);
});

test("Firefox loads a history page extension after the transform", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  const out = transformManifest(manifest({ history: "history.html" }), [], options);
  assert.equal(await firefoxRefusal(out, { "history.html": "<!doctype html>" }), null);
});
