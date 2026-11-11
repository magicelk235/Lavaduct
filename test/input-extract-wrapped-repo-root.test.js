import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractExtension } from "../dist/input/extract.js";
import { zipDirectory } from "../dist/zip/write.js";

const tmp = () => mkdtempSync(join(tmpdir(), "input-extract-wrapped-"));

function zipOf(files) {
  const src = tmp();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(src, rel, ".."), { recursive: true });
    writeFileSync(join(src, rel), text);
  }
  const zip = join(tmp(), "repo.zip");
  zipDirectory(src, zip);
  return zip;
}

// GitHub's "Download ZIP" wraps the repo in <repo>-<branch>/, so a repo that keeps
// its extension in a subfolder next to other folders has the manifest two levels down.
test("a repo zip wrapped in one folder finds the extension subfolder inside it", () => {
  const zip = zipOf({
    "native-host-main/README.md": "x",
    "native-host-main/extension/manifest.json": '{"manifest_version":3,"name":"X","version":"1"}',
    "native-host-main/extension/bg.js": "1",
    "native-host-main/host/host.py": "print()",
  });
  const root = extractExtension(zip, tmp());
  assert.equal(readFileSync(join(root, "bg.js"), "utf-8"), "1");
});

test("two extension folders inside the wrapper are still ambiguous", () => {
  const zip = zipOf({
    "repo-main/a/manifest.json": "{}",
    "repo-main/b/manifest.json": "{}",
  });
  const scratch = tmp();
  assert.equal(extractExtension(zip, scratch), join(scratch, "extension"));
});
