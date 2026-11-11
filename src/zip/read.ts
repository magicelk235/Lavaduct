import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/** One central-directory record, with zip64 values already resolved. */
interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  externalAttrs: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Zip field is too large");
  return Number(v);
}

/** Offset of the end-of-central-directory record, searched backwards over the comment window. */
function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_SIZE - MAX_COMMENT);
  let fallback = -1;
  for (let i = buf.length - EOCD_SIZE; i >= stop; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    // The comment length has to reach exactly to the end of the file; a match
    // that doesn't is most likely the signature bytes showing up in the comment.
    if (i + EOCD_SIZE + buf.readUInt16LE(i + 20) === buf.length) return i;
    if (fallback < 0) fallback = i;
  }
  if (fallback >= 0) return fallback;
  throw new Error("Not a zip archive (no end-of-central-directory record)");
}

function readCentralDirectory(buf: Buffer): CentralEntry[] {
  if (buf.length < EOCD_SIZE) throw new Error("Not a zip archive (file too short)");
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let cdEnd = eocd;

  // A zip64 end record sits right before its locator, which sits right before
  // the EOCD. The locator's offset is as written, so bytes prepended to the
  // archive leave it short; the record's fixed-size form then ends exactly at
  // the locator. Either way the central directory ends where the record starts.
  const locator = eocd - 20;
  if (locator >= 0 && buf.readUInt32LE(locator) === SIG_ZIP64_LOCATOR) {
    let z = u64(buf, locator + 8);
    if (z + 56 > locator || buf.readUInt32LE(z) !== SIG_ZIP64_EOCD) z = locator - 56;
    const found = z >= 0 && buf.readUInt32LE(z) === SIG_ZIP64_EOCD;
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      if (!found) throw new Error("Corrupt zip64 archive (bad zip64 end-of-central-directory record)");
      count = u64(buf, z + 32);
      cdSize = u64(buf, z + 40);
      cdOffset = u64(buf, z + 48);
    }
    if (found) cdEnd = z;
  }

  // Offsets normally count from the start of the buffer. omni.ja puts its
  // central directory right at the front and says so in the EOCD, so trust the
  // written offset first. Archives with bytes prepended after they were written
  // (a stub, or a container header) have every offset short by the same amount;
  // the directory then ends where the EOCD begins, which gives the shift.
  let shift = 0;
  if (cdOffset + 4 > buf.length || buf.readUInt32LE(cdOffset) !== SIG_CENTRAL) {
    const actual = cdEnd - cdSize;
    if (count > 0 && (actual < 0 || buf.readUInt32LE(actual) !== SIG_CENTRAL)) {
      throw new Error("Corrupt zip archive (central directory not found)");
    }
    shift = actual - cdOffset;
    cdOffset = actual;
  }

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`Corrupt zip archive (central directory entry ${n} is damaged)`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    let localOffset = buf.readUInt32LE(p + 42);
    const nameStart = p + 46;
    const extraStart = nameStart + nameLen;
    if (extraStart + extraLen > buf.length) throw new Error("Corrupt zip archive (truncated central directory)");
    const name = buf.toString("utf-8", nameStart, extraStart);

    // The zip64 extra field carries only the values whose 32-bit slot is maxed out, in this order.
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = extraStart;
      while (e + 4 <= extraStart + extraLen) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = u64(buf, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(buf, q); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(buf, q); }
          break;
        }
        e += 4 + len;
      }
    }

    entries.push({ name, flags, method, crc, compressedSize, size, localOffset: localOffset + shift, externalAttrs });
    p = extraStart + extraLen + commentLen;
  }
  return entries;
}

function isDirectoryEntry(e: CentralEntry): boolean {
  return e.name.endsWith("/") || e.name.endsWith("\\");
}

function entryData(buf: Buffer, e: CentralEntry): Buffer {
  if (e.flags & 1) throw new Error(`Cannot read encrypted zip entry: ${e.name}`);
  const h = e.localOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== SIG_LOCAL) {
    throw new Error(`Corrupt zip archive (bad local header for ${e.name})`);
  }
  // Sizes come from the central directory: with a data descriptor (flag bit 3)
  // the local header's size fields are zero.
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw new Error(`Corrupt zip archive (truncated data for ${e.name})`);
  const raw = buf.subarray(start, end);

  let out: Buffer;
  if (e.method === 0) {
    out = raw;
  } else if (e.method === 8) {
    try {
      // Capping the output at the declared size keeps a lying header from inflating without bound.
      out = inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
    } catch (err) {
      throw new Error(`Corrupt zip entry ${e.name}: ${(err as Error).message}`);
    }
  } else {
    throw new Error(`Unsupported compression method ${e.method} for zip entry ${e.name}`);
  }
  if (out.length !== e.size) throw new Error(`Corrupt zip entry ${e.name} (size mismatch)`);
  if (crc32(out) !== e.crc) throw new Error(`Corrupt zip entry ${e.name} (CRC mismatch)`);
  return out;
}

export function listZip(buf: Buffer): ZipEntry[] {
  return readCentralDirectory(buf).map((e) => ({ name: e.name, isDirectory: isDirectoryEntry(e), size: e.size }));
}

/** Contents of the entry named exactly `name`, or null when there's no such file. */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const entries = readCentralDirectory(buf);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.name === name && !isDirectoryEntry(e)) return entryData(buf, e);
  }
  return null;
}

/**
 * Entry name split into path segments, or an error when it could land outside
 * the extraction directory: absolute paths, drive letters, `..` segments.
 */
function safeSegments(name: string): string[] {
  if (name.includes("\0")) throw new Error(`Refusing zip entry with a NUL byte in its name: ${JSON.stringify(name)}`);
  const path = name.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`Refusing zip entry with an absolute path (zip-slip): ${name}`);
  }
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) throw new Error(`Refusing zip entry that escapes the extraction directory (zip-slip): ${name}`);
  return segments;
}

/**
 * Extract every entry into destDir. All names are checked before anything is
 * written, so a malicious archive leaves nothing behind.
 */
export function extractZip(buf: Buffer, destDir: string): void {
  const entries = readCentralDirectory(buf);
  const root = resolve(destDir);
  const prefix = root.endsWith(sep) ? root : root + sep;
  const plan: Array<{ entry: CentralEntry; target: string; dir: boolean }> = [];
  for (const entry of entries) {
    // Unix file type in the high half of the external attributes; 0o120000 is a symlink.
    if (((entry.externalAttrs >>> 16) & 0o170000) === 0o120000) {
      throw new Error(`Refusing zip entry that is a symlink (zip-slip risk): ${entry.name}`);
    }
    const segments = safeSegments(entry.name);
    if (segments.length === 0) continue;
    const target = join(root, ...segments);
    if (!target.startsWith(prefix)) throw new Error(`Refusing zip entry that escapes the extraction directory (zip-slip): ${entry.name}`);
    plan.push({ entry, target, dir: isDirectoryEntry(entry) });
  }

  mkdirSync(root, { recursive: true });
  for (const { entry, target, dir } of plan) {
    if (dir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entryData(buf, entry));
  }
}
