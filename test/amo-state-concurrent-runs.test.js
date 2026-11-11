import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE_URL = new URL("../dist/sign/amo.js", import.meta.url).href;
const RUNS = 8;

// An AMO that accepts every submission at once and never signs, so each run ends
// pending with its version recorded in amo-versions.json and amo-pending.json.
async function startAmo() {
  let nextId = 1;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const status = req.method === "GET" ? 200 : 201;
      res.writeHead(status, { "Content-Type": "application/json" });
      if (req.method === "POST") return res.end(JSON.stringify({ uuid: "u1", processed: true, valid: true, validation: { messages: [] } }));
      if (req.method === "PUT") return res.end(JSON.stringify({ version: { id: nextId++, edit_url: "https://amo.test/edit" } }));
      res.end(JSON.stringify({ file: { status: "unreviewed" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

// One lavaduct process signing its own add-on, started at the agreed moment.
const RUN = `
  import { mkdirSync, writeFileSync } from "node:fs";
  import { createHash } from "node:crypto";
  const { signWithAmo } = await import(process.env.MODULE_URL);
  const work = process.env.WORK;
  mkdirSync(work, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.START_AT) - Date.now()));
  const outcome = await signWithAmo({
    addonId: process.env.ADDON_ID,
    baseVersion: "1.0.0",
    credentials: { key: "user:1:2", secret: "s" },
    outDir: work,
    baseUrl: process.env.AMO,
    pollMs: 5,
    approvalTimeoutMs: 1,
    pack(version) {
      const data = Buffer.from(process.env.ADDON_ID + version);
      const xpiPath = work + "/addon.xpi";
      writeFileSync(xpiPath, data);
      return { xpiPath, sha256: createHash("sha256").update(data).digest("hex") };
    },
  });
  process.stdout.write(outcome.kind);
`;

function runAll(root, baseUrl) {
  const startAt = Date.now() + 800;
  return Promise.all(
    Array.from(
      { length: RUNS },
      (_, i) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", RUN], {
            env: {
              ...process.env,
              LAVADUCT_STATE_DIR: join(root, "state"),
              LAVADUCT_CACHE_DIR: join(root, "cache"),
              MODULE_URL,
              WORK: join(root, `work${i}`),
              ADDON_ID: `addon${i}@example.com`,
              AMO: baseUrl,
              START_AT: String(startAt),
            },
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`run ${i} exited ${code}: ${err}`))));
        }),
    ),
  );
}

test("runs signing at the same time keep every pending submission and version record", async (t) => {
  const amo = await startAmo();
  t.after(amo.close);

  for (let round = 0; round < 3; round++) {
    const root = mkdtempSync(join(tmpdir(), "lavaduct-amo-concurrent-"));
    try {
      const outcomes = await runAll(root, amo.baseUrl);
      assert.deepEqual(outcomes, Array(RUNS).fill("pending"));

      const pending = JSON.parse(readFileSync(join(root, "state", "amo-pending.json"), "utf-8"));
      const versions = JSON.parse(readFileSync(join(root, "state", "amo-versions.json"), "utf-8"));
      const ids = Array.from({ length: RUNS }, (_, i) => `addon${i}@example.com`);
      assert.deepEqual(pending.map((p) => p.addonId).sort(), ids, `round ${round}: pending records`);
      assert.deepEqual(Object.keys(versions).sort(), ids, `round ${round}: version records`);
      assert.ok(!existsSync(join(root, "state", "amo-state.lock")), "lock released");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
