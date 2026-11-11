import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip } from "../dist/zip/read.js";
import { buildZip } from "./zip-fixtures.js";

// extractZip checks every name before it writes anything. An archive that uses one
// path as a file and as a folder can't be extracted either way round; it has to be
// refused up front, not halfway through with EEXIST or EISDIR.
for (const [label, entries] of [
  ["a file, then a folder of the same name", [{ name: "a", data: "f" }, { name: "a/b.js", data: "x" }]],
  ["a folder entry, then a file of the same name", [{ name: "a/", data: "" }, { name: "a", data: "f" }]],
  ["a nested file, then a file at its folder's path", [{ name: "x/y/z.js", data: "1" }, { name: "x/y", data: "2" }]],
]) {
  test(`extraction refuses ${label} and writes nothing`, () => {
    const dest = join(mkdtempSync(join(tmpdir(), "zip-clash-")), "out");
    const zip = buildZip([{ name: "manifest.json", data: "{}" }, ...entries]);
    assert.throws(() => extractZip(zip, dest), /both a file .* and a folder/);
    assert.equal(existsSync(dest), false);
  });
}

test("folder entries alongside the files inside them still extract", () => {
  const dest = mkdtempSync(join(tmpdir(), "zip-clash-"));
  extractZip(buildZip([{ name: "js/", data: "" }, { name: "js/a.js", data: "1" }, { name: "js/", data: "" }]), dest);
  assert.ok(existsSync(join(dest, "js", "a.js")));
});
