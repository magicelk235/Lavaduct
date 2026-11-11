// A URL input is untrusted, and the 100 MB download cap says nothing about what an
// archive expands to. Each entry was held to its declared size, but nothing capped
// the sum, the entry count, or entries sharing one stream of bytes (the overlapping
// zip bomb), so a small archive could fill the disk before anything checked it.
// All three are refused before a single file is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip } from "../dist/zip/read.js";
import { buildZip } from "./zip-fixtures.js";

const CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

function dest(t) {
  const dir = mkdtempSync(join(tmpdir(), "zip-caps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "out");
}

/** Offsets of the central directory records, in order. */
function centralRecords(zip) {
  const out = [];
  for (let at = zip.indexOf(CENTRAL); at !== -1; at = zip.indexOf(CENTRAL, at + 4)) out.push(at);
  return out;
}

test("entries that share their data are refused", (t) => {
  const zip = buildZip([
    { name: "manifest.json", data: "{}" },
    { name: "a.js", data: "x".repeat(1000), deflate: true },
    { name: "b.js", data: "y".repeat(1000), deflate: true },
  ]);
  const [, a, b] = centralRecords(zip);
  zip.writeUInt32LE(zip.readUInt32LE(a + 42), b + 42); // b.js now points at a.js's bytes
  const out = dest(t);
  assert.throws(() => extractZip(zip, out), /a\.js and b\.js share data/);
  assert.equal(existsSync(out), false);
});

test("an archive declaring more than 2 GiB of files is refused", (t) => {
  const zip = buildZip([
    { name: "manifest.json", data: "{}" },
    { name: "huge.bin", data: "z", deflate: true },
    { name: "huge2.bin", data: "z", deflate: true },
  ]);
  const [, first, second] = centralRecords(zip);
  zip.writeUInt32LE(0xc0000000, first + 24); // 3 GiB uncompressed
  zip.writeUInt32LE(0x10, second + 24);
  const out = dest(t);
  assert.throws(() => extractZip(zip, out), /more than 2 GiB/);
  assert.equal(existsSync(out), false);
});

test("an archive with more entries than an add-on can hold is refused", (t) => {
  const entries = Array.from({ length: 0x10000 }, (_, i) => ({ name: `f/${i}.js`, data: "" }));
  const out = dest(t);
  assert.throws(() => extractZip(buildZip(entries, { zip64Eocd: true }), out), /65536 entries/);
  assert.equal(existsSync(out), false);
});

test("an ordinary archive still extracts", (t) => {
  const out = dest(t);
  extractZip(buildZip([{ name: "manifest.json", data: "{}" }, { name: "a/b.js", data: "b", deflate: true }]), out);
  assert.ok(existsSync(join(out, "a", "b.js")));
});
