import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type * as Sqlite from "node:sqlite";
import { NAME } from "../name.js";
import { encodeIdbStringKey } from "./idb-key.js";
import { snappyDecompressFramed, snappyDecompressRaw } from "./snappy.js";
import { readStructuredClone } from "./structured-clone.js";

/** storage.local key the --debug ring buffer persists under (see runtime/debug-ring.js). */
export const DEBUG_LOG_KEY = "__viaduct_debug_log__";

export interface DebugLogEntry {
  /** epoch ms */
  t: number;
  /** background | content | page */
  ctx: string;
  msg: string;
}

// Firefox keeps an add-on's storage.local in an IndexedDB database of its
// moz-extension origin, under a user context of its own (-1 >>> 0). The file name
// is IndexedDB's hash of the database name, "webExtensions-storage-local".
const ORIGIN_SUFFIX = "^userContextId=4294967295";
const DB_FILE = "3647222921wleabcEoxlt-eengsairo.sqlite";
const FILES_DIR = "3647222921wleabcEoxlt-eengsairo.files";
const STORE = "storage-local-data";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The internal UUID Firefox gave the add-on, from the extensions.webextensions.uuids pref. */
function addonUuid(profilePath: string, addonId: string): string {
  const prefsPath = join(profilePath, "prefs.js");
  let prefs: string;
  try {
    prefs = readFileSync(prefsPath, "utf-8");
  } catch {
    throw new Error(`No prefs.js in ${profilePath}. Is it a Firefox profile?`);
  }
  // prefs.js holds the pref as a string literal escaped like JSON, and the string
  // is itself a JSON map of add-on ID to UUID.
  const literal = /^user_pref\("extensions\.webextensions\.uuids",\s*("(?:[^"\\]|\\.)*")\);/m.exec(prefs)?.[1];
  let uuid: unknown;
  try {
    const uuids: unknown = literal ? JSON.parse(JSON.parse(literal)) : undefined;
    if (typeof uuids === "object" && uuids !== null) uuid = (uuids as Record<string, unknown>)[addonId];
  } catch {
    // A pref that doesn't parse has no UUID to offer.
  }
  if (typeof uuid !== "string" || !UUID.test(uuid)) {
    throw new Error(
      `${addonId} has no internal UUID in ${prefsPath}. It isn't installed in this profile, ` +
        `or Firefox hasn't saved its prefs since installing it.`,
    );
  }
  return uuid;
}

function fileStamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "missing";
  }
}

// Firefox holds an exclusive lock on the live database on macOS and Linux, and
// opening it at all would leave a -shm file in the profile, so the database and
// its -wal are copied and the copy is read. A copy Firefox wrote to halfway
// through is taken again.
function copyDatabase(dbPath: string, scratch: string): string {
  const sources = [dbPath, `${dbPath}-wal`];
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = sources.map(fileStamp).join();
    for (const src of sources) {
      const dest = join(scratch, basename(src));
      try {
        copyFileSync(src, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        rmSync(dest, { force: true });
      }
    }
    if (sources.map(fileStamp).join() === before) return join(scratch, basename(dbPath));
  }
  throw new Error(`Firefox kept writing to ${dbPath} while it was being copied. Try again.`);
}

let sqliteModule: typeof Sqlite | undefined;

// Node 22 prints an ExperimentalWarning the first time node:sqlite loads, so it's
// loaded only when a log is read, with that warning held back.
function loadSqlite(): typeof Sqlite {
  if (sqliteModule) return sqliteModule;
  const emitWarning = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]): void {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: unknown } | undefined)?.type;
    if (type === "ExperimentalWarning") return;
    (emitWarning as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqliteModule;
}

/** A storage.local row's value: a BLOB, or an INTEGER when the value is kept in .files/. */
interface StoredValue {
  data: Uint8Array | bigint;
  file_ids: string | null;
}

function queryValue(dbCopy: string, dbPath: string, key: Buffer): StoredValue | undefined {
  const { DatabaseSync } = loadSqlite();
  let db: Sqlite.DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbCopy, { readOnly: true });
    const stmt = db.prepare(
      "SELECT d.data, d.file_ids FROM object_data d JOIN object_store s ON s.id = d.object_store_id " +
        "WHERE s.name = ? AND d.key = ?",
    );
    stmt.setReadBigInts(true);
    return stmt.get(STORE, key) as StoredValue | undefined;
  } catch (e) {
    throw new Error(`Could not read ${dbPath}: ${(e as Error).message}`);
  } finally {
    db?.close();
  }
}

// IndexedDB moves a value whose compressed size could pass 1 MiB out of the row
// into <db>.files/<id>, compressed in Snappy's framing format. The row's data is
// then flags << 32 | an index into its space-separated file_ids, where a
// structured-clone file is marked with a leading ".".
function readExternalValue(idbDir: string, data: bigint, fileIds: string | null): Buffer {
  const token = (fileIds ?? "").split(" ")[Number(data & 0xffffffffn)];
  const id = token?.startsWith(".") ? token.slice(1) : "";
  if (!/^\d+$/.test(id)) {
    throw new Error(`${join(idbDir, DB_FILE)} keeps the log in a file it doesn't name (file_ids "${fileIds}").`);
  }
  const file = join(idbDir, FILES_DIR, id);
  let framed: Buffer;
  try {
    framed = readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    throw new Error(`${file} was replaced while the log was being read. Try again.`);
  }
  return snappyDecompressFramed(framed);
}

function isDebugLogEntry(v: unknown): v is DebugLogEntry {
  if (typeof v !== "object" || v === null) return false;
  const { t, ctx, msg } = v as Record<string, unknown>;
  return typeof t === "number" && !Number.isNaN(new Date(t).getTime()) && typeof ctx === "string" && typeof msg === "string";
}

/**
 * Read the --debug ring buffer an add-on persisted to storage.local in a Firefox
 * profile. Works while Firefox is running, and never writes to the profile.
 * `source` is the add-on's storage.local database.
 */
export function readDebugLog(profilePath: string, addonId: string): { entries: DebugLogEntry[]; source: string } {
  const uuid = addonUuid(profilePath, addonId);
  const idbDir = join(profilePath, "storage", "default", `moz-extension+++${uuid}${ORIGIN_SUFFIX}`, "idb");
  const dbPath = join(idbDir, DB_FILE);
  if (!existsSync(dbPath)) {
    throw new Error(
      `${addonId} has no storage.local data in this profile (no ${dbPath}). ` +
        `A --debug conversion creates it once it logs something.`,
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), `${NAME}-logs-`));
  let row: StoredValue | undefined;
  try {
    row = queryValue(copyDatabase(dbPath, scratch), dbPath, encodeIdbStringKey(DEBUG_LOG_KEY));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!row) {
    throw new Error(
      `${addonId} has no debug log. The log only exists in a --debug conversion: ` +
        `convert with --debug, reinstall, use the extension, then try again.`,
    );
  }

  const clone =
    typeof row.data === "bigint" ? readExternalValue(idbDir, row.data, row.file_ids) : snappyDecompressRaw(Buffer.from(row.data));
  const value = readStructuredClone(clone);
  if (!Array.isArray(value) || !value.every(isDebugLogEntry)) {
    throw new Error(`${addonId}: the value stored under ${DEBUG_LOG_KEY} isn't a debug log.`);
  }
  return { entries: value, source: dbPath };
}

/** One line per entry: ISO timestamp, context label, message. */
export function formatDebugLog(entries: DebugLogEntry[]): string {
  return entries.map((e) => `${new Date(e.t).toISOString()} [${e.ctx}] ${e.msg}`).join("\n");
}
