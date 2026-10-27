import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

// 1980-01-01 00:00, the earliest DOS date. Every entry gets it so the archive
// depends only on file names and contents.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const FLAG_UTF8 = 0x0800;

/** Regular files under dir as sorted `/`-separated relative paths. Symlinks are skipped. */
function collectFiles(root: string, skip: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, relPath);
      else if (st.isFile() && full !== skip) out.push(relPath);
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Pack srcDir into a zip at outPath. The output is a pure function of the
 * tree's paths and bytes: sorted entries, fixed timestamps, no directory
 * entries, no permissions. Each file is deflated at level 9, or stored when
 * that's no bigger.
 */
export function zipDirectory(srcDir: string, outPath: string): void {
  const root = resolve(srcDir);
  const out = resolve(outPath);
  const files = collectFiles(root, out);
  if (files.length > 0xffff) throw new Error(`Too many files to pack (${files.length}); the limit is 65535`);

  mkdirSync(dirname(out), { recursive: true });
  const fd = openSync(out, "w");
  const central: Buffer[] = [];
  let offset = 0;
  const write = (b: Buffer): void => {
    writeSync(fd, b);
    offset += b.length;
  };
  try {
    for (const rel of files) {
      const data = readFileSync(join(root, rel));
      const deflated = deflateRawSync(data, { level: 9 });
      const stored = deflated.length >= data.length;
      const body = stored ? data : deflated;
      const name = Buffer.from(rel, "utf-8");
      const flags = name.length !== rel.length ? FLAG_UTF8 : 0;
      const method = stored ? 0 : 8;
      const version = stored ? 10 : 20;
      const crc = crc32(data);
      if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error(`Archive too large to pack: ${rel}`);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(version, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(DOS_TIME, 10);
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(version, 4); // made by: MS-DOS host, so no Unix modes are implied
      cd.writeUInt16LE(version, 6);
      cd.writeUInt16LE(flags, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(DOS_TIME, 12);
      cd.writeUInt16LE(DOS_DATE, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(body.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(name.length, 28);
      cd.writeUInt32LE(offset, 42);
      central.push(cd, name);

      write(local);
      write(name);
      write(body);
    }

    const cdOffset = offset;
    const cdBytes = Buffer.concat(central);
    write(cdBytes);
    if (cdOffset >= 0xffffffff) throw new Error("Archive too large to pack");

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBytes.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    write(eocd);
  } finally {
    closeSync(fd);
  }
}
