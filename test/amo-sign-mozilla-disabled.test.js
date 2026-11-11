import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signWithAmo } from "../dist/sign/amo.js";

const ADDON_ID = "test-addon@example.com";
const DENIED = "You do not have permission to perform this action.";

// AMO's v5 upload accepts the file, then the submission is refused with the 403 that
// AddonViewSet.check_object_permissions sends: the generic permission message plus
// whether the add-on's developer or Mozilla disabled it.
async function startAmo(disabledByMozilla) {
  const requests = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(req.method === "PUT" ? 403 : 201, { "Content-Type": "application/json" });
      if (req.method === "PUT") {
        res.end(JSON.stringify({ detail: DENIED, is_disabled_by_developer: false, is_disabled_by_mozilla: disabledByMozilla }));
      } else {
        res.end(JSON.stringify({ uuid: "abc123", processed: true, valid: true, validation: { messages: [] } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lavaduct-amo-disabled-"));
  process.env.LAVADUCT_STATE_DIR = join(root, "state");
  process.env.LAVADUCT_CACHE_DIR = join(root, "cache");
  mkdirSync(join(root, "work"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sign = (amo) =>
  signWithAmo({
    addonId: ADDON_ID,
    baseVersion: "1.0.0",
    credentials: { key: "user:1:2", secret: "s" },
    pack(version) {
      const data = Buffer.from(`PK\x03\x04${version}`, "latin1");
      const xpiPath = join(root, "work", "Test.xpi");
      writeFileSync(xpiPath, data);
      return { xpiPath, sha256: createHash("sha256").update(data).digest("hex") };
    },
    outDir: join(root, "out"),
    baseUrl: amo.baseUrl,
    pollMs: 10,
    approvalTimeoutMs: 1000,
  });

test("a submission refused because Mozilla disabled the add-on says so, not that another account owns it", async (t) => {
  const amo = await startAmo(true);
  t.after(amo.close);

  const outcome = await sign(amo);

  assert.equal(outcome.kind, "rejected");
  assert.match(outcome.issues[0].message, /Mozilla disabled/);
  assert.doesNotMatch(outcome.issues[0].message, /another AMO account/);
  assert.match(outcome.issues[0].fix, /--addon-id/);
});

test("a 403 for an add-on that isn't disabled still points at the account that owns the ID", async (t) => {
  const amo = await startAmo(false);
  t.after(amo.close);

  const outcome = await sign(amo);

  assert.equal(outcome.kind, "rejected");
  assert.match(outcome.issues[0].message, /another AMO account/);
});
