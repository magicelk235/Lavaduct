import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import { parseJsonc } from "../manifest/manifest.js";
import { extractZip } from "../zip/read.js";

/** Parse a .crx (Chrome) container, returning the embedded ZIP bytes. */
function crxToZip(crxPath: string): Buffer {
  const buf = readFileSync(crxPath);
  if (buf.subarray(0, 4).toString("ascii") !== "Cr24") {
    throw new Error(`Invalid CRX file (bad magic): ${crxPath}`);
  }
  // Magic (4) + version (4) = 8 bytes minimum before we can read the version.
  if (buf.length < 8) throw new Error(`Invalid CRX file (truncated header): ${crxPath}`);
  const version = buf.readUInt32LE(4);
  let zipStart: number;
  if (version === 2) {
    // v2 header: magic(4) version(4) pubKeyLen(4) sigLen(4) = 16 bytes min.
    if (buf.length < 16) throw new Error(`Invalid CRX file (truncated v2 header): ${crxPath}`);
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    zipStart = 16 + pubKeyLen + sigLen;
  } else if (version === 3) {
    // v3 header: magic(4) version(4) headerLen(4) = 12 bytes min.
    if (buf.length < 12) throw new Error(`Invalid CRX file (truncated v3 header): ${crxPath}`);
    const headerLen = buf.readUInt32LE(8);
    zipStart = 12 + headerLen;
  } else {
    throw new Error(`Unsupported CRX version: ${version}`);
  }
  if (!Number.isFinite(zipStart) || zipStart < 0 || zipStart >= buf.length) {
    // >= : a header that fills the whole file leaves a 0-byte ZIP, which would
    // fail later with a vague unzip error instead of this CRX-specific one.
    throw new Error(`Invalid CRX file (no ZIP payload after header): ${crxPath}`);
  }
  return buf.subarray(zipStart);
}

/**
 * Pull the extension's public key (DER, base64) from a CRX header so a Chrome id
 * can be derived — CWS manifests ship without `key`, but the CRX carries it. v2
 * stores the key inline; v3 wraps a CrxFileHeader protobuf whose signed_header_data
 * holds the authoritative 16-byte crx_id — we return the AsymmetricKeyProof key that
 * hashes to it (there can be several proofs; only one matches). Returns undefined
 * when the container is unparseable.
 */
function crxPublicKeyBase64(crxPath: string): string | undefined {
  let buf: Buffer;
  try { buf = readFileSync(crxPath); } catch { return undefined; }
  if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "Cr24") return undefined;
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    if (pubKeyLen <= 0 || buf.length < 16 + pubKeyLen) return undefined;
    return buf.subarray(16, 16 + pubKeyLen).toString("base64");
  }
  if (version !== 3) return undefined;
  const headerLen = buf.readUInt32LE(8);
  if (headerLen <= 0 || buf.length < 12 + headerLen) return undefined;
  const hdr = buf.subarray(12, 12 + headerLen);
  // Minimal protobuf field walk: (tag as varint) then value by wire type.
  const fields = (b: Buffer): Array<{ field: number; val: Buffer }> => {
    const out: Array<{ field: number; val: Buffer }> = [];
    let i = 0;
    const vint = (): number => { let s = 0, r = 0, x = 0; do { x = b[i++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80 && i < b.length); return r >>> 0; };
    while (i < b.length) {
      const tag = vint(); const field = tag >>> 3; const wt = tag & 7;
      if (wt === 2) { const len = vint(); out.push({ field, val: b.subarray(i, i + len) }); i += len; }
      else if (wt === 0) { vint(); }
      else if (wt === 5) { i += 4; }
      else if (wt === 1) { i += 8; }
      else break;
    }
    return out;
  };
  const top = fields(hdr);
  const signed = top.find((f) => f.field === 10000);
  let crxId: Buffer | undefined;
  if (signed) { const s = fields(signed.val).find((f) => f.field === 1); if (s) crxId = s.val; }
  const proofs = top.filter((f) => f.field === 2 || f.field === 3);
  for (const pr of proofs) {
    const pub = fields(pr.val).find((f) => f.field === 1);
    if (!pub) continue;
    if (!crxId) return pub.val.toString("base64");
    if (createHash("sha256").update(pub.val).digest().subarray(0, 16).equals(crxId)) return pub.val.toString("base64");
  }
  return undefined;
}

/**
 * Resolve the directory that actually contains manifest.json.
 * Many zips wrap the extension in a single top-level folder.
 */
function resolveExtensionRoot(dir: string, depth = 0): string {
  if (existsSync(join(dir, "manifest.json"))) return dir;
  const entries = readdirSync(dir).filter((e) => !e.startsWith("__MACOSX") && e !== ".DS_Store");
  const subdirs = entries.filter((e) => {
    try {
      return statSync(join(dir, e)).isDirectory();
    } catch {
      return false; // broken symlink or unreadable entry
    }
  });
  if (subdirs.length === 1 && existsSync(join(dir, subdirs[0], "manifest.json"))) {
    return join(dir, subdirs[0]);
  }
  // A repo-style layout nests the extension alongside siblings that are NOT the
  // extension (host binaries, docs, build scripts) — e.g. the Chrome
  // native-messaging sample's `extension/` + `host/` + `README.md`. The single
  // top-level-folder check above misses that. So when the root has no manifest,
  // look for subdirs that DO carry one: if exactly one does, descend into it.
  // Two or more is ambiguous (a monorepo of extensions) — stay put and let the
  // caller error rather than silently pick the wrong one.
  const manifestSubdirs = subdirs.filter((e) => existsSync(join(dir, e, "manifest.json")));
  if (manifestSubdirs.length === 1) {
    return join(dir, manifestSubdirs[0]);
  }
  // A lone wrapper folder around such a layout: GitHub's "Download ZIP" puts the
  // whole repo in <repo>-<branch>/, so the extension sits two levels down, next
  // to its siblings. Apply the same rules inside the wrapper; when they find
  // nothing either, stay put as before.
  if (subdirs.length === 1 && depth < 2) {
    const inner = resolveExtensionRoot(join(dir, subdirs[0]), depth + 1);
    if (existsSync(join(inner, "manifest.json"))) return inner;
  }
  return dir;
}

/**
 * Sniff the archive kind from MAGIC BYTES, not the file extension. Users often
 * download a CRX renamed to .zip (or a zip-based .xpi), so trust the content:
 * "Cr24" → crx, "PK\x03\x04" → zip. Returns null when neither magic matches.
 */
function sniffArchiveKind(path: string): "crx" | "zip" | null {
  const head = Buffer.alloc(4);
  try {
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (head.toString("ascii") === "Cr24") return "crx";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "zip";
  return null;
}

/**
 * Extract a .zip / .crx archive (or pass through a directory) into scratchDir.
 * Returns the path to the extension root (the folder holding manifest.json).
 */
export function extractExtension(inputPath: string, scratchDir: string): string {
  // A directory is used in place: it's the user's own tree and is only read.
  if (statSync(inputPath).isDirectory()) return resolveExtensionRoot(inputPath);

  const destDir = join(scratchDir, "extension");

  // Prefer magic bytes (authoritative) over the extension (a renamed CRX/.xpi is
  // common); fall back to the suffix only when the bytes are inconclusive.
  const suffix = extname(inputPath).toLowerCase();
  const kind = sniffArchiveKind(inputPath) ?? (suffix === ".crx" ? "crx" : suffix === ".zip" || suffix === ".xpi" ? "zip" : null);

  if (kind === "crx") {
    extractZip(crxToZip(inputPath), destDir);
  } else if (kind === "zip") {
    extractZip(readFileSync(inputPath), destDir);
  } else {
    throw new Error(`Unsupported input "${inputPath}": not a CRX or ZIP archive (or a directory).`);
  }

  const root = resolveExtensionRoot(destDir);
  // CWS manifests ship without `key`, so the Chrome id can't be derived from the
  // staged manifest alone. Recover it from the CRX header and inject it, so the
  // rest of the pipeline (add-on ID, chrome-extension origin) has a real id.
  if (kind === "crx") {
    const key = crxPublicKeyBase64(inputPath);
    if (key) {
      const mfPath = join(root, "manifest.json");
      try {
        // Lenient parse (same as loadManifest): a CRX'd Chrome manifest may carry a
        // BOM/comments/trailing commas, on which strict JSON.parse throws — dropping
        // the recovered key and losing the derived Chrome id downstream. Rewritten
        // back as clean JSON, the shape the rest of the pipeline re-reads anyway.
        const mf = parseJsonc<{ key?: string }>(readFileSync(mfPath, "utf-8"));
        if (!mf.key) { mf.key = key; writeFileSync(mfPath, JSON.stringify(mf, null, 2)); }
      } catch { /* leave manifest as-is if unreadable */ }
    }
  }

  return root;
}
