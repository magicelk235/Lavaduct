// Staging never ships a symlink that leads out of the extension folder, so the
// analyzer must not follow one either: a `link -> /` in a folder input made
// --analyze walk the whole disk and report files that never reach Firefox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanExtension } from "../dist/analyze/analyze.js";

const MIN = { minFirefox: "153.0" };
const LACKING = "chrome.declarativeContent.onPageChanged.addRules([]);\n";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "analyze-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ext = join(root, "ext");
  mkdirSync(join(ext, "real"), { recursive: true });
  mkdirSync(join(root, "outside"));
  writeFileSync(join(ext, "manifest.json"), "{}");
  writeFileSync(join(ext, "real", "inside.js"), LACKING);
  writeFileSync(join(root, "outside", "elsewhere.js"), LACKING);
  return { root, ext };
}

function link(t, target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (e) {
    t.skip(`can't create a symlink here: ${e.code}`);
    return false;
  }
}

const manifest = { manifest_version: 3, name: "Links", version: "1" };
const files = (issues) => issues.filter((i) => i.category === "api").map((i) => i.file.split("\\").join("/")).sort();

test("a folder or file symlink that leads out of the input is not scanned", (t) => {
  const { root, ext } = fixture(t);
  if (!link(t, join(root, "outside"), join(ext, "dirlink"))) return;
  if (!link(t, join(root, "outside", "elsewhere.js"), join(ext, "filelink.js"))) return;

  assert.deepEqual(files(scanExtension(ext, manifest, MIN)), ["real/inside.js"]);
});

test("a symlink that stays inside the input, which staging copies when the manifest names it, is still scanned", (t) => {
  const { ext } = fixture(t);
  if (!link(t, join(ext, "real", "inside.js"), join(ext, "alias.js"))) return;

  assert.deepEqual(files(scanExtension(ext, manifest, MIN)), ["alias.js", "real/inside.js"]);
});
