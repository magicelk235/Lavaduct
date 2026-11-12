// Chrome takes any non-empty omnibox keyword. Firefox's schema refuses one with
// whitespace or a colon, or starting with "?" (^[^?\s:][^\s:]*$), and with it the
// whole add-on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";
import { firefox, firefoxRefusal } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const manifest = (keyword) => ({ manifest_version: 3, name: "Search", version: "1.0", omnibox: { keyword }, background: { scripts: ["bg.js"] } });
const keyword = (k) => transformManifest(manifest(k), [], options).omnibox?.keyword;

test("a keyword Firefox refuses loses its whitespace, colons and leading question marks", () => {
  assert.equal(keyword("my notes"), "mynotes");
  assert.equal(keyword("gh:"), "gh");
  assert.equal(keyword("?? find\tit"), "findit");
});

test("a keyword Firefox takes, or one it checks after localizing, is left alone", () => {
  assert.equal(keyword("notes"), "notes");
  assert.equal(keyword("a?b"), "a?b");
  assert.equal(keyword("__MSG_keyword__"), "__MSG_keyword__");
});

test("a keyword with nothing left removes the omnibox, which Firefox can't have without one", () => {
  assert.equal("omnibox" in transformManifest(manifest(" : "), [], options), false);
});

test("the analyzer and the report name the new keyword", () => {
  const { issues } = analyzeManifest(manifest("my notes"), { minFirefox: DEFAULT_MIN_FIREFOX });
  const [issue] = issues.filter((i) => i.message.includes("omnibox keyword"));
  assert.equal(issue?.autoFixed, true);
  assert.ok(issue.message.includes('"mynotes"'), issue.message);
  assert.equal(analyzeManifest(manifest("notes"), { minFirefox: DEFAULT_MIN_FIREFOX }).issues.filter((i) => i.message.includes("omnibox keyword")).length, 0);
  const before = manifest("my notes");
  const changes = summarizeManifestChanges(before, transformManifest(before, [], options));
  assert.ok(changes.some((c) => c.includes("`my notes`") && c.includes("`mynotes`")), changes.join("\n"));
});

test("Firefox loads the transformed manifest", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  assert.match(await firefoxRefusal(manifest("my notes"), { "bg.js": "" }), /omnibox\.keyword/);
  assert.equal(await firefoxRefusal(transformManifest(manifest("my notes"), [], options), { "bg.js": "" }), null);
});
