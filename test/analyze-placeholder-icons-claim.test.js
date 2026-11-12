// The analyzer said "a placeholder icon set is generated" whenever the manifest had
// no icons key, but the conversion writes placeholders only when no action icon
// exists either. With action.default_icon set it wrote none, so the report claimed
// an auto-fix that never happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeManifest } from "../dist/manifest/manifest.js";
import { synthesizePlaceholderIcons } from "../dist/input/icons.js";

const placeholderClaim = (m) => analyzeManifest(m, { minFirefox: "153.0" }).issues.filter((i) => /placeholder icon set/.test(i.message));

function generated(t, m) {
  const dir = mkdtempSync(join(tmpdir(), "placeholder-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return synthesizePlaceholderIcons(dir, structuredClone(m), "X").length > 0;
}

test("no placeholder claim when the action declares the icons", (t) => {
  for (const m of [
    { manifest_version: 3, name: "X", version: "1", action: { default_icon: { 16: "i16.png" } } },
    { manifest_version: 2, name: "X", version: "1", browser_action: { default_icon: "i.png" } },
  ]) {
    assert.equal(generated(t, m), false);
    assert.deepEqual(placeholderClaim(m), []);
    assert.ok(analyzeManifest(m, { minFirefox: "153.0" }).issues.some((i) => i.category === "ui" && !i.autoFixed && /generic icon/.test(i.message)));
  }
});

test("the claim stays when placeholders are written", (t) => {
  for (const m of [
    { manifest_version: 3, name: "X", version: "1" },
    { manifest_version: 3, name: "X", version: "1", action: { default_icon: {} } },
  ]) {
    assert.equal(generated(t, m), true);
    assert.equal(placeholderClaim(m).length, 1);
  }
});
