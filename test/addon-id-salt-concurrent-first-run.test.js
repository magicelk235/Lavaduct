import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const MODULE_URL = new URL("../dist/sign/addon-id.js", import.meta.url).href;

// Each worker waits on a shared flag, then derives an ID the moment it is released,
// so all of them reach the missing salt file together, like first runs started at once.
const WORKER = `
  import { workerData, parentPort } from "node:worker_threads";
  const { deriveAddonId } = await import(workerData.moduleUrl);
  const flag = new Int32Array(workerData.flag);
  parentPort.postMessage("ready");
  Atomics.wait(flag, 0, 0);
  try {
    parentPort.postMessage({ id: deriveAddonId({ name: "My Extension" }) });
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
`;

async function firstRunsAtOnce(stateDir, count) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const workers = Array.from(
    { length: count },
    () =>
      new Worker(WORKER, {
        eval: true,
        type: "module",
        workerData: { moduleUrl: MODULE_URL, flag: flag.buffer },
        env: { ...process.env, LAVADUCT_STATE_DIR: stateDir },
      }),
  );
  const ready = workers.map((w) => new Promise((resolve) => w.once("message", resolve)));
  const results = workers.map(
    (w) =>
      new Promise((resolve, reject) => {
        w.on("message", (m) => typeof m === "object" && resolve(m));
        w.once("error", reject);
      }),
  );
  await Promise.all(ready);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  try {
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

test("first runs racing to create the add-on ID salt all get the same salt, none an error", async () => {
  for (let round = 0; round < 80; round++) {
    const dir = mkdtempSync(join(tmpdir(), "lavaduct-salt-race-"));
    try {
      const results = await firstRunsAtOnce(dir, 8);
      const errors = results.filter((r) => r.error).map((r) => r.error);
      assert.deepEqual(errors, [], `round ${round}`);
      assert.equal(new Set(results.map((r) => r.id)).size, 1, `round ${round}: ${results.map((r) => r.id)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
