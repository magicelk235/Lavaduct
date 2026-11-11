import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// SQLite truncates a database's -wal when it checkpoints (Firefox's IndexedDB
// lets it reach 5,000 pages, then cuts it back). libuv's copyfile loop never
// ends when the source shrinks under it: past the new end every read returns
// nothing and it asks again for the bytes it was promised. readDebugLog copied
// the live -wal with copyFileSync, so a checkpoint during the copy hung --logs.

const FIXTURE_PROFILE = fileURLToPath(new URL("./fixtures/storage/profile/", import.meta.url));
const SMALL_IDB =
  "storage/default/moz-extension+++51e49ec1-e720-4012-8255-977c75257b68^userContextId=4294967295/idb";
const WAL = "3647222921wleabcEoxlt-eengsairo.sqlite-wal";
const SMALL_LOG = [
  { t: 1793091600123, ctx: "background", msg: "[console.warn] storage at 80%" },
  { t: 1793091601456, ctx: "content", msg: "naïve café" },
  { t: 1793091602789, ctx: "page", msg: "[uncaught] 日本語 🚀 — failed" },
];

const scratch = mkdtempSync(join(tmpdir(), "storage-wal-shrink-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Grows the -wal with 256 MiB of zeros, which SQLite ignores as frames that
// don't check out, waits until readDebugLog's copy of it appears in the
// reader's temp directory, then cuts it back to its real size and keeps it so.
const SHRINKER = String.raw`
  const { ftruncateSync, openSync, readdirSync, existsSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const [wal, readerTmp, name] = process.argv.slice(1);
  const size = statSync(wal).size;
  const fd = openSync(wal, "r+");
  ftruncateSync(fd, 256 * 1024 * 1024);
  process.stdout.write("grown\n");
  const copying = () => readdirSync(readerTmp).some((d) => existsSync(join(readerTmp, d, name)));
  while (!copying()) {}
  ftruncateSync(fd, size);
  process.stdout.write("shrunk\n");
  setInterval(() => {}, 1000);
`;

test("a -wal that SQLite truncates while it's being copied doesn't hang the read", async () => {
  const profile = join(scratch, "profile");
  cpSync(FIXTURE_PROFILE, profile, { recursive: true });
  const readerTmp = join(scratch, "tmp");
  mkdirSync(readerTmp);

  const shrinker = spawn(process.execPath, ["--input-type=module", "-e", SHRINKER, join(profile, SMALL_IDB, WAL), readerTmp, WAL], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise((resolve, reject) => {
      shrinker.stdout.once("data", resolve);
      shrinker.once("exit", () => reject(new Error("the shrinker exited early")));
    });

    const storage = new URL("../dist/firefox/storage.js", import.meta.url).href;
    const script = `
      const { readDebugLog } = await import(${JSON.stringify(storage)});
      process.stdout.write(JSON.stringify(readDebugLog(${JSON.stringify(profile)}, "small@fixture.test").entries));
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, TMPDIR: readerTmp, TMP: readerTmp, TEMP: readerTmp },
    });
    assert.equal(res.signal, null, "readDebugLog never returned");
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), SMALL_LOG);
  } finally {
    shrinker.kill();
  }
});
