import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { extractExtension } from "../dist/input/extract.js";
import { zipDirectory } from "../dist/zip/write.js";

const CORPUS = "/Users/magicelk235/Desktop/Projects/magicelklabs/aqueduct/test extensions";
const tmp = (p = "input-extract-") => mkdtempSync(join(tmpdir(), p));

for (const file of ["dark reader.crx", "Lighthouse.zip"]) {
  const path = join(CORPUS, file);
  test(`extracts ${file} to a folder with manifest.json`, { skip: !existsSync(path) && "corpus not present" }, () => {
    const root = extractExtension(path, tmp());
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
    assert.ok(manifest.name);
    if (file.endsWith(".crx")) assert.ok(manifest.key, "CRX public key was not injected");
  });
}

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
const field = (num, bytes) => Buffer.concat([varint((num << 3) | 2), varint(bytes.length), bytes]);

/** CRX3 around a zip, with a header padded by a large unknown protobuf field. */
function buildCrx3(zip, pubKey) {
  const crxId = createHash("sha256").update(pubKey).digest().subarray(0, 16);
  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, pubKey), field(2, randomBytes(256))])),
    field(99, randomBytes(300_000)),
    field(10000, field(1, crxId)),
  ]);
  const prelude = Buffer.alloc(12);
  prelude.write("Cr24", 0, "ascii");
  prelude.writeUInt32LE(3, 4);
  prelude.writeUInt32LE(header.length, 8);
  return Buffer.concat([prelude, header, zip]);
}

test("a CRX3 with a large header extracts and gains the matching public key", () => {
  const src = tmp();
  mkdirSync(join(src, "wrapped"));
  writeFileSync(join(src, "wrapped/manifest.json"), '{\n  // comment\n  "manifest_version": 3, "name": "X", "version": "1",\n}');
  writeFileSync(join(src, "wrapped/bg.js"), "1");
  const work = tmp();
  zipDirectory(src, join(work, "p.zip"));
  const pub = randomBytes(294);
  const crxPath = join(work, "renamed.zip"); // magic bytes decide, not the suffix
  writeFileSync(crxPath, buildCrx3(readFileSync(join(work, "p.zip")), pub));

  const root = extractExtension(crxPath, tmp());
  assert.equal(readFileSync(join(root, "bg.js"), "utf-8"), "1");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
  assert.equal(manifest.key, pub.toString("base64"));
});

test("a file that is neither CRX nor ZIP is rejected", () => {
  const p = join(tmp(), "thing.bin");
  writeFileSync(p, "hello");
  assert.throws(() => extractExtension(p, tmp()), /not a CRX or ZIP/);
});
