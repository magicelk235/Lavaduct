// An .xpi input that Mozilla signed carries META-INF/ (the signature over the old
// files and the old add-on ID) and, for Recommended add-ons, mozilla-recommendation.json.
// Both were staged and packed. addons-linter refuses mozilla-recommendation.json
// anywhere in a package (RESERVED_FILENAME, an error, so AMO won't sign it) and
// warns that a package with META-INF/manifest.mf is already signed; Firefox checks
// the stale signature against files the conversion rewrote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageExtension } from "../dist/input/stage.js";

function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), "stage-signed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "src");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, rel)), { recursive: true });
    writeFileSync(join(src, rel), text);
  }
  return { src, stage: join(root, "stage") };
}

test("a signed package's META-INF and mozilla-recommendation.json aren't staged", (t) => {
  const { src, stage } = tree(t, {
    "manifest.json": "{}",
    "META-INF/manifest.mf": "Manifest-Version: 1.0",
    "META-INF/mozilla.rsa": "sig",
    "META-INF/cose.sig": "sig",
    "mozilla-recommendation.json": "{}",
    "lib/mozilla-recommendation.json": "{}",
    "lib/META-INF/notes.txt": "a folder of the extension's own",
  });
  stageExtension(src, stage);
  assert.equal(existsSync(join(stage, "META-INF")), false);
  assert.equal(existsSync(join(stage, "mozilla-recommendation.json")), false);
  assert.equal(existsSync(join(stage, "lib/mozilla-recommendation.json")), false);
  assert.ok(existsSync(join(stage, "lib/META-INF/notes.txt")), "only the package root's META-INF is the signature");
  assert.ok(existsSync(join(stage, "manifest.json")));
});
