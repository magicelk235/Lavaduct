import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { formatDebugLog, readDebugLog } from "../dist/firefox/storage.js";

// A profile captured from headless Firefox 158 with three temporary add-ons:
//   small@fixture.test  a 3-entry log, copied while Firefox ran, so its rows are only in the -wal
//   large@fixture.test  a 2000-entry log over 1 MiB, which IndexedDB keeps in .files/
//   nolog@fixture.test  storage.local settings but no debug log
const FIXTURE_PROFILE = fileURLToPath(new URL("./fixtures/storage/profile/", import.meta.url));
const SMALL_DB =
  "storage/default/moz-extension+++51e49ec1-e720-4012-8255-977c75257b68^userContextId=4294967295/idb/3647222921wleabcEoxlt-eengsairo.sqlite";

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "storage-test-"));
  tempDirs.push(dir);
  return dir;
}

function profileCopy() {
  const dir = tempDir();
  cpSync(FIXTURE_PROFILE, dir, { recursive: true });
  return dir;
}

function snapshotTree(dir, prefix = "") {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, snapshotTree(path, `${prefix}${name}/`));
    else out[prefix + name] = readFileSync(path).toString("base64");
  }
  return out;
}

const SMALL_LOG = [
  { t: 1793091600123, ctx: "background", msg: "[console.warn] storage at 80%" },
  { t: 1793091601456, ctx: "content", msg: "naïve café" },
  { t: 1793091602789, ctx: "page", msg: "[uncaught] 日本語 🚀 — failed" },
];

function largeLog() {
  const ctxs = ["background", "content", "page"];
  const log = [];
  for (let i = 0; i < 2000; i++) {
    log.push({
      t: 1793091600000 + i * 1000,
      ctx: ctxs[i % 3],
      msg: (i % 100 === 99 ? "日本語 " : "") + "[console.error] request " + i + " failed: " + "x".repeat(560),
    });
  }
  return log;
}

test("reads a log that only reached the -wal file of a running Firefox", () => {
  const profile = profileCopy();
  const { entries, source } = readDebugLog(profile, "small@fixture.test");
  assert.deepEqual(entries, SMALL_LOG);
  assert.equal(source, join(profile, SMALL_DB));
});

test("reads a log over 1 MiB that IndexedDB moved into the .files directory", () => {
  const { entries } = readDebugLog(profileCopy(), "large@fixture.test");
  assert.deepEqual(entries, largeLog());
});

test("formats one line per entry with an ISO time and the context", () => {
  assert.equal(
    formatDebugLog(SMALL_LOG),
    [
      "2026-10-27T09:00:00.123Z [background] [console.warn] storage at 80%",
      "2026-10-27T09:00:01.456Z [content] naïve café",
      "2026-10-27T09:00:02.789Z [page] [uncaught] 日本語 🚀 — failed",
    ].join("\n"),
  );
});

test("reads while another connection holds the database's exclusive lock, as Firefox does", () => {
  const profile = profileCopy();
  const holder = new DatabaseSync(join(profile, SMALL_DB));
  try {
    holder.exec("PRAGMA locking_mode = EXCLUSIVE");
    holder.prepare("SELECT count(*) FROM object_data").get();
    assert.throws(() => {
      const direct = new DatabaseSync(join(profile, SMALL_DB), { readOnly: true });
      direct.prepare("SELECT count(*) FROM object_data").get();
    }, /locked/);
    assert.deepEqual(readDebugLog(profile, "small@fixture.test").entries, SMALL_LOG);
  } finally {
    holder.close();
  }
});

test("leaves the profile exactly as it was", () => {
  const profile = profileCopy();
  const before = snapshotTree(profile);
  readDebugLog(profile, "small@fixture.test");
  readDebugLog(profile, "large@fixture.test");
  assert.deepEqual(snapshotTree(profile), before);
});

test("an add-on the profile has no UUID for is reported by its ID", () => {
  assert.throws(() => readDebugLog(profileCopy(), "missing@fixture.test"), /missing@fixture\.test.*UUID/);
});

test("an add-on that never stored anything is reported", () => {
  const profile = tempDir();
  const uuids = JSON.stringify({ "ghost@fixture.test": "0b7c3f4e-8a52-4a1e-9a6e-2f7d1c9e5b31" });
  writeFileSync(join(profile, "prefs.js"), `user_pref("extensions.webextensions.uuids", ${JSON.stringify(uuids)});\n`);
  mkdirSync(join(profile, "storage", "default"), { recursive: true });
  assert.throws(() => readDebugLog(profile, "ghost@fixture.test"), /ghost@fixture\.test.*storage\.local/);
});

test("an add-on without a debug log points at --debug", () => {
  assert.throws(() => readDebugLog(profileCopy(), "nolog@fixture.test"), /nolog@fixture\.test[\s\S]*--debug/);
});

test("reading a log prints nothing to stderr", () => {
  const storage = new URL("../dist/firefox/storage.js", import.meta.url).href;
  const script = `
    const { readDebugLog } = await import(${JSON.stringify(storage)});
    readDebugLog(${JSON.stringify(profileCopy())}, "small@fixture.test");
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf-8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, "");
});
