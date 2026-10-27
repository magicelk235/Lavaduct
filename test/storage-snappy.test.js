import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { snappyDecompressFramed, snappyDecompressRaw } from "../dist/firefox/snappy.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/storage/", import.meta.url));
// The "types" row of small@fixture.test exactly as Firefox stored it (a raw block), and
// its decompression by an independent Snappy implementation.
const typesBlock = readFileSync(join(FIXTURES, "types.snappy"));
const typesClone = readFileSync(join(FIXTURES, "types.clone"));
// The same clone bytes framed by a spec-conformant encoder.
const typesFramed = readFileSync(join(FIXTURES, "types.framed"));
// large@fixture.test's debug log, which IndexedDB moved out of the row into .files/.
const largeFile = readFileSync(
  join(
    FIXTURES,
    "profile/storage/default/moz-extension+++e92c37f4-f301-4dfd-babd-81ad0eb2c205^userContextId=4294967295",
    "idb/3647222921wleabcEoxlt-eengsairo.files/1",
  ),
);

test("a raw block from an IndexedDB row decompresses to the stored clone bytes", () => {
  assert.deepEqual(snappyDecompressRaw(typesBlock), typesClone);
});

test("a framed file from IndexedDB's .files directory decompresses in full", () => {
  const out = snappyDecompressFramed(largeFile);
  assert.equal(out.length, 1425440);
  assert.equal(
    createHash("sha256").update(out).digest("hex"),
    "0b1b199111e7047710a2f542d8ef65d118c877b05f99ebf48a7e5713e3fe01c0",
  );
});

test("a framed stream with spec checksums decompresses too", () => {
  assert.deepEqual(snappyDecompressFramed(typesFramed), typesClone);
});

test("a framed chunk whose checksum doesn't match is rejected", () => {
  const damaged = Buffer.from(largeFile);
  // Bytes 0-9 are the stream identifier, 10-13 the first chunk's header, 14-17 its checksum.
  damaged[14] ^= 0x01;
  assert.throws(() => snappyDecompressFramed(damaged), /checksum/i);
});

test("truncated or inconsistent raw blocks are rejected", () => {
  assert.throws(() => snappyDecompressRaw(typesBlock.subarray(0, typesBlock.length - 1)));
  // Declares 4 bytes, then copies from before the start of the output.
  assert.throws(() => snappyDecompressRaw(Buffer.from([0x04, 0x01, 0x01])));
  assert.throws(() => snappyDecompressFramed(typesBlock), /framed/i);
});
