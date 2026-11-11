import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip, listZip, readZipEntry } from "../dist/zip/read.js";
import { buildZip } from "./zip-fixtures.js";

const tmp = () => mkdtempSync(join(tmpdir(), "zip-read-"));

test("entries written with data descriptors extract with the right contents", () => {
  const text = "console.log('hello');\n".repeat(200);
  const zip = buildZip([
    { name: "manifest.json", data: '{"manifest_version":3}', deflate: true, descriptor: true },
    { name: "js/bg.js", data: text, deflate: true, descriptor: true },
  ]);
  const dest = tmp();
  extractZip(zip, dest);
  assert.equal(readFileSync(join(dest, "manifest.json"), "utf-8"), '{"manifest_version":3}');
  assert.equal(readFileSync(join(dest, "js/bg.js"), "utf-8"), text);
});

test("zip64 end records and size fields are honoured", () => {
  const zip = buildZip(
    [
      { name: "a.txt", data: "alpha", zip64: true },
      { name: "b.txt", data: "beta ".repeat(100), deflate: true, zip64: true },
    ],
    { zip64Eocd: true },
  );
  assert.deepEqual(
    listZip(zip).map((e) => [e.name, e.size]),
    [["a.txt", 5], ["b.txt", 500]],
  );
  assert.equal(readZipEntry(zip, "b.txt").toString(), "beta ".repeat(100));
});

test("an archive with bytes prepended still reads", () => {
  const zip = buildZip([{ name: "x.txt", data: "x" }]);
  const shifted = Buffer.concat([Buffer.from("junk header bytes"), zip]);
  assert.equal(readZipEntry(shifted, "x.txt").toString(), "x");
});

test("readZipEntry returns null for a missing name", () => {
  const zip = buildZip([{ name: "x.txt", data: "x" }]);
  assert.equal(readZipEntry(zip, "y.txt"), null);
});

for (const [label, name] of [
  ["a .. segment", "../evil"],
  ["a nested .. segment", "dir/../../evil"],
  ["a backslash .. segment", "..\\evil"],
  ["an absolute path", "/tmp/evil"],
  ["a drive letter", "C:/evil"],
]) {
  test(`extraction refuses ${label} and writes nothing`, () => {
    const zip = buildZip([
      { name: "manifest.json", data: "{}" },
      { name, data: "pwned" },
    ]);
    const dest = join(tmp(), "out");
    assert.throws(() => extractZip(zip, dest), /zip-slip/);
    assert.equal(existsSync(dest), false);
  });
}

test("extraction refuses symlink entries", () => {
  const zip = buildZip([{ name: "link", data: "/etc/passwd", unixMode: 0o120777 }]);
  const dest = tmp();
  assert.throws(() => extractZip(zip, dest), /symlink/);
  assert.deepEqual(readdirSync(dest), []);
});

test("a corrupted entry is reported instead of extracted silently", () => {
  const zip = buildZip([{ name: "a.txt", data: "hello world" }]);
  const i = zip.indexOf("hello world");
  zip[i] ^= 0xff;
  assert.throws(() => extractZip(zip, tmp()), /CRC mismatch/);
});

const OMNI = "/Applications/Firefox.app/Contents/Resources/omni.ja";
test("reads AppConstants out of Firefox's omni.ja", { skip: !existsSync(OMNI) && "no local Firefox" }, () => {
  const omni = readFileSync(OMNI);
  const src = readZipEntry(omni, "modules/AppConstants.sys.mjs");
  assert.ok(src, "AppConstants.sys.mjs not found");
  assert.match(src.toString("utf-8"), /MOZ_REQUIRE_SIGNING/);
});
