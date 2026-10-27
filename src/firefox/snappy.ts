// Snappy decompression for the two forms Firefox's IndexedDB writes: raw blocks in
// the database rows and the framing format in the .files directory. Decompression
// only. The input is a file another program wrote, so every length and offset is
// checked before use and anything malformed throws.

function corrupt(what: string): Error {
  return new Error(`Corrupt Snappy data: ${what}`);
}

/** Decompress a raw Snappy block: a varint length, then literals and back-copies. */
export function snappyDecompressRaw(buf: Buffer): Buffer {
  let ip = 0;
  // The uncompressed length as a varint of at most 32 bits.
  let length = 0;
  for (let shift = 0; ; shift += 7) {
    if (ip >= buf.length || shift > 28) throw corrupt("truncated length");
    const byte = buf[ip++];
    length += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
  }
  // The densest element is a 3-byte copy that yields 64 bytes, so a length far
  // beyond ~22x the input can't be real. Refusing it keeps a corrupt preamble
  // from turning into a huge allocation.
  if (length > 0xffffffff || length > buf.length * 32) throw corrupt("impossible length");

  const out = Buffer.allocUnsafe(length);
  let op = 0;

  const copyBack = (offset: number, count: number): void => {
    if (offset === 0 || offset > op) throw corrupt("copy offset out of range");
    if (count > length - op) throw corrupt("output longer than declared");
    if (offset >= count) {
      out.copy(out, op, op - offset, op - offset + count);
      op += count;
      return;
    }
    // Byte by byte when the source overlaps the destination: the copy reads bytes
    // it has just written, which is how Snappy encodes runs.
    for (let from = op - offset, end = op + count; op < end; ) out[op++] = out[from++];
  };

  while (ip < buf.length) {
    const tag = buf[ip++];
    switch (tag & 0x03) {
      case 0x00: {
        // Literal. Lengths up to 60 sit in the tag; longer ones follow it in 1-4
        // little-endian bytes.
        let count = tag >>> 2;
        if (count >= 60) {
          const extra = count - 59;
          if (buf.length - ip < extra) throw corrupt("truncated literal length");
          count = buf.readUIntLE(ip, extra);
          ip += extra;
        }
        count += 1;
        if (count > buf.length - ip) throw corrupt("truncated literal");
        if (count > length - op) throw corrupt("output longer than declared");
        buf.copy(out, op, ip, ip + count);
        ip += count;
        op += count;
        break;
      }
      case 0x01: {
        // Copy with a 3-bit length and an 11-bit offset.
        if (ip >= buf.length) throw corrupt("truncated copy");
        copyBack(((tag >>> 5) << 8) | buf[ip++], 4 + ((tag >>> 2) & 0x07));
        break;
      }
      case 0x02: {
        // Copy with a 6-bit length and a 16-bit offset.
        if (buf.length - ip < 2) throw corrupt("truncated copy");
        const offset = buf.readUInt16LE(ip);
        ip += 2;
        copyBack(offset, 1 + (tag >>> 2));
        break;
      }
      default: {
        // Copy with a 6-bit length and a 32-bit offset.
        if (buf.length - ip < 4) throw corrupt("truncated copy");
        const offset = buf.readUInt32LE(ip);
        ip += 4;
        copyBack(offset, 1 + (tag >>> 2));
      }
    }
  }

  if (op !== length) throw corrupt("output shorter than declared");
  return out;
}

const STREAM_IDENTIFIER = Buffer.from("sNaPpY", "latin1");

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32C as Firefox computes it: seeded with ~0 and never inverted at the end. */
function firefoxCrc32c(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC32C_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function maskChecksum(crc: number): number {
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

/**
 * Decompress a stream in Snappy's framing format: a "sNaPpY" stream identifier,
 * then chunks of compressed or uncompressed data, each with a masked CRC-32C of
 * its uncompressed bytes.
 */
export function snappyDecompressFramed(buf: Buffer): Buffer {
  if (buf.length < 10 || buf[0] !== 0xff || buf.readUIntLE(1, 3) !== 6 || !buf.subarray(4, 10).equals(STREAM_IDENTIFIER)) {
    throw new Error("Not framed Snappy data: it doesn't start with the sNaPpY stream identifier");
  }
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos < 4) throw corrupt("truncated chunk header");
    const type = buf[pos];
    const size = buf.readUIntLE(pos + 1, 3);
    const body = buf.subarray(pos + 4, pos + 4 + size);
    if (body.length !== size) throw corrupt("truncated chunk");
    pos += 4 + size;

    if (type === 0xff) {
      if (!body.equals(STREAM_IDENTIFIER)) throw corrupt("bad stream identifier");
    } else if (type === 0x00 || type === 0x01) {
      if (size < 4) throw corrupt("chunk without a checksum");
      const data = type === 0x00 ? snappyDecompressRaw(body.subarray(4)) : body.subarray(4);
      // The framing format inverts the CRC once more before masking; Firefox
      // doesn't, so its checksums are the complement of a standard encoder's.
      // Either one is genuine.
      const stored = body.readUInt32LE(0);
      const crc = firefoxCrc32c(data);
      if (stored !== maskChecksum(crc) && stored !== maskChecksum(~crc >>> 0)) {
        throw corrupt("chunk checksum mismatch");
      }
      parts.push(data);
    } else if (type <= 0x7f) {
      throw corrupt(`reserved chunk type 0x${type.toString(16).padStart(2, "0")}`);
    }
    // 0x80-0xfe are padding and reserved skippable chunks.
  }
  return Buffer.concat(parts);
}
