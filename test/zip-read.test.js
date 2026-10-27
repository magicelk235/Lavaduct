import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { extractZip, listZip, readZipEntry } from "../dist/zip/read.js";

/**
 * Hand-assemble a zip so tests control every header field.
 * entry: { name, data, deflate?, descriptor?, unixMode?, zip64? }
 */
function buildZip(entries, { prefix = Buffer.alloc(0), zip64Eocd = false } = {}) {
  const parts = [prefix];
  const central = [];
  let offset = prefix.length;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const body = e.deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const flags = e.descriptor ? 0x08 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    // With a data descriptor the local header leaves crc and sizes zero.
    if (!e.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const chunk = [local, name, body];
    if (e.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(data.length, 12);
      chunk.push(dd);
    }

    let extra = Buffer.alloc(0);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(e.unixMode ? 0x0314 : 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc, 16);
    if (e.zip64) {
      cd.writeUInt32LE(0xffffffff, 20);
      cd.writeUInt32LE(0xffffffff, 24);
      cd.writeUInt32LE(0xffffffff, 42);
      extra = Buffer.alloc(4 + 24);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    } else {
      cd.writeUInt32LE(body.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt32LE(offset, 42);
    }
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    if (e.unixMode) cd.writeUInt32LE((e.unixMode << 16) >>> 0, 38);
    central.push(cd, name, extra);

    for (const c of chunk) offset += c.length;
    parts.push(...chunk);
  }
  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  parts.push(cdBuf);
  offset += cdBuf.length;
  if (zip64Eocd) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(entries.length), 24);
    z.writeBigUInt64LE(BigInt(entries.length), 32);
    z.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    z.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64Eocd ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64Eocd ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64Eocd ? 0xffffffff : cdBuf.length, 12);
  eocd.writeUInt32LE(zip64Eocd ? 0xffffffff : cdOffset, 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}

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
