import { crc32, deflateRawSync } from "node:zlib";

/**
 * Hand-assemble a zip so tests control every header field.
 * entry: { name (string or raw Buffer), data, deflate?, descriptor?, unixMode?, zip64?, flags? }
 * zip64Eocd adds the zip64 end record and locator; zip64Maxed (default true) also
 * maxes the 32-bit EOCD fields so readers have to use them.
 */
export function buildZip(entries, { prefix = Buffer.alloc(0), zip64Eocd = false, zip64Maxed = true } = {}) {
  const parts = [prefix];
  const central = [];
  let offset = prefix.length;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const body = e.deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const flags = (e.descriptor ? 0x08 : 0) | (e.flags ?? 0);
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
  const maxed = zip64Eocd && zip64Maxed;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(maxed ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(maxed ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(maxed ? 0xffffffff : cdBuf.length, 12);
  eocd.writeUInt32LE(maxed ? 0xffffffff : cdOffset, 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}
