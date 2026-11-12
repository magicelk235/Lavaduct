// The analyzer warned that with externally_connectable.ids "any add-on may message
// this one". Since b6b4b0c the shim lets only the listed extensions through, matched
// by the Chrome ID a lavaduct-converted sender's add-on ID starts with, so the claim
// was false for a normal build and true only without the shim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest } from "../dist/manifest/manifest.js";

const manifest = {
  manifest_version: 3,
  name: "X",
  version: "1",
  externally_connectable: { ids: ["abcdefghijklmnopabcdefghijklmnop"] },
};
const idsIssue = (opts) =>
  analyzeManifest(structuredClone(manifest), { minFirefox: "153.0", ...opts }).issues.find((i) => /externally_connectable\.ids/.test(i.message));

test("with the shim, the ids warning says unlisted add-ons are kept out and listed ones must be lavaduct conversions", () => {
  const issue = idsIssue({});
  assert.ok(issue);
  assert.doesNotMatch(issue.message, /any add-on may message/);
  assert.match(issue.message, /converted by lavaduct/);
});

test("without the shim, the ids warning says any add-on may message the add-on", () => {
  const issue = idsIssue({ shim: false });
  assert.ok(issue);
  assert.match(issue.message, /any add-on may message/);
});
