import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signWithAmo } from "../dist/sign/amo.js";

const ADDON_ID = "test-addon@example.com";
const SIGNED = "PK\x03\x04signed 1.0.0";

// AMO's v5 flow, signing at once, with a download that can drop the connection after
// sending part of the file, the way a flaky network ends a response mid-body.
async function startAmo() {
  const amo = { dropDownload: true, requests: [] };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url, "http://amo.test").pathname;
      amo.requests.push(`${req.method} ${path}`);
      const json = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST") return json(201, { uuid: "abc123", processed: true, valid: true, validation: { messages: [] } });
      if (req.method === "PUT") return json(201, { version: { id: 7, edit_url: `${amo.baseUrl}/edit/7` } });
      if (path.endsWith("/versions/7/")) {
        return json(200, { id: 7, file: { status: "public", url: `${amo.baseUrl}/firefox/downloads/file/7/signed.xpi` } });
      }
      if (path === "/firefox/downloads/file/7/signed.xpi") {
        res.writeHead(200, { "Content-Type": "application/x-xpinstall", "Content-Length": String(SIGNED.length) });
        if (!amo.dropDownload) return res.end(SIGNED, "latin1");
        res.write(SIGNED.slice(0, 6), "latin1");
        return setTimeout(() => res.destroy(), 20);
      }
      json(404, { detail: "Not found." });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  amo.baseUrl = `http://127.0.0.1:${server.address().port}`;
  amo.close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return amo;
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lavaduct-amo-drop-"));
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

test("a signed download cut off mid-file names AMO as unreachable, caches nothing, and the next run resumes", async (t) => {
  const amo = await startAmo();
  t.after(amo.close);

  await assert.rejects(sign(amo), /^Error: Couldn't reach AMO at http:\/\/127\.0\.0\.1:\d+: /);
  assert.ok(!existsSync(join(root, "out")), "no signed file written");
  assert.ok(!existsSync(join(root, "cache", "amo-signed")) || readdirSync(join(root, "cache", "amo-signed")).length === 0);

  amo.dropDownload = false;
  const outcome = await sign(amo);

  assert.equal(outcome.kind, "signed");
  assert.equal(readFileSync(outcome.signedXpiPath, "latin1"), SIGNED);
  assert.equal(amo.requests.filter((r) => r.startsWith("POST")).length, 1, "resumed without uploading again");
});
