import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip, listZip, readZipEntry } from "../dist/zip/read.js";
import { buildZip } from "./zip-fixtures.js";

// Without the UTF-8 flag a zip name is code page 437 (Windows' built-in zipper
// writes "café.png" as 63 61 66 82 2e 70 6e 67). Tools that write UTF-8 without
// the flag keep working because a name that is valid UTF-8 is read as UTF-8.
const cp437Name = Buffer.from([0x69, 0x6d, 0x67, 0x2f, 0x63, 0x61, 0x66, 0x82, 0x2e, 0x70, 0x6e, 0x67]); // img/café.png

test("a name without the UTF-8 flag that isn't UTF-8 is read as code page 437", () => {
  const zip = buildZip([
    { name: cp437Name, data: "png" },
    { name: Buffer.from([0x94, 0x81, 0xe1]), data: "x" }, // öüß
  ]);
  assert.deepEqual(listZip(zip).map((e) => e.name), ["img/café.png", "öüß"]);
  assert.equal(readZipEntry(zip, "img/café.png").toString(), "png");
  const dest = mkdtempSync(join(tmpdir(), "zip-cp437-"));
  extractZip(zip, dest);
  assert.ok(existsSync(join(dest, "img", "café.png")));
});

test("UTF-8 names read as UTF-8 with or without the flag", () => {
  const zip = buildZip([
    { name: "img/naïve.png", data: "a" },
    { name: "日本.js", data: "b", flags: 0x0800 },
  ]);
  assert.deepEqual(listZip(zip).map((e) => e.name), ["img/naïve.png", "日本.js"]);
});
