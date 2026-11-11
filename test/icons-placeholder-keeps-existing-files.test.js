import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthesizePlaceholderIcons } from "../dist/input/icons.js";

// An extension without manifest icons can still ship a file named icon-128.png that
// its popup shows. The placeholder set must not replace it with a solid square.
test("placeholder icons never overwrite a file the extension ships", () => {
  const stage = mkdtempSync(join(tmpdir(), "icons-placeholder-"));
  writeFileSync(join(stage, "icon-128.png"), "the extension's own logo");
  writeFileSync(join(stage, "icon-128-1.png"), "another file");
  const manifest = { manifest_version: 3, name: "T", version: "1", action: { default_popup: "popup.html" } };

  assert.deepEqual(synthesizePlaceholderIcons(stage, manifest, "T"), [48, 128, 256, 512]);
  assert.equal(readFileSync(join(stage, "icon-128.png"), "utf-8"), "the extension's own logo");
  assert.equal(readFileSync(join(stage, "icon-128-1.png"), "utf-8"), "another file");
  assert.deepEqual(manifest.icons, { 48: "icon-48.png", 128: "icon-128-2.png", 256: "icon-256.png", 512: "icon-512.png" });
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  for (const file of Object.values(manifest.icons)) {
    assert.deepEqual([...readFileSync(join(stage, file)).subarray(1, 4)], [0x50, 0x4e, 0x47], `${file} is a PNG`);
  }
});
