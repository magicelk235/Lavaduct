import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpFourthComponent, checkAmoCredentials, removeSignedCache, signWithAmo } from "../dist/sign/amo.js";

const KEY = "user:12345:67";
const SECRET = "0123456789abcdef".repeat(4);
const ADDON_ID = "test-addon@example.com";

// A stand-in for addons.mozilla.org's v5 API: just enough of the upload, submit,
// version-status and download endpoints, with knobs for the failure modes.
async function startFakeAmo(knobs = {}) {
  const amo = {
    requests: [],
    alwaysConflict: false,
    processedOnCreate: true,
    invalid: false,
    putStatus: undefined,
    rateLimitedUploads: 0,
    status: "public",
    pollsUntilDone: 1,
    ...knobs,
    usedVersions: new Set(knobs.usedVersions ?? []),
    uploads: new Map(),
    versions: new Map(),
    nextVersionId: 100,
  };

  const versionJson = (id) => {
    const v = amo.versions.get(id);
    return {
      id,
      version: v.version,
      edit_url: `${amo.baseUrl}/en-US/developers/addon/${encodeURIComponent(v.guid)}/versions/${id}`,
      file: {
        id: id + 1000,
        status: v.polls >= amo.pollsUntilDone ? amo.status : "unreviewed",
        url: `${amo.baseUrl}/firefox/downloads/file/${id}/signed.xpi`,
      },
    };
  };

  const uploadJson = (uuid, processed) => ({
    uuid,
    channel: "unlisted",
    processed,
    submitted: false,
    valid: processed && !amo.invalid,
    validation: processed
      ? {
          errors: amo.invalid ? 1 : 0,
          warnings: 1,
          messages: [
            ...(amo.invalid
              ? [{ type: "error", message: "Unsafe call to eval", description: ["Avoid eval."], file: "background.js", line: 3 }]
              : []),
            { type: "warning", message: "Unsafe assignment to innerHTML", description: "Use textContent.", file: "popup.js", line: 9 },
          ],
        }
      : null,
    version: amo.uploads.get(uuid)?.version,
  });

  const verifyJwt = (header) => {
    const m = /^JWT ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(header ?? "");
    if (!m) return false;
    if (createHmac("sha256", SECRET).update(`${m[1]}.${m[2]}`).digest("base64url") !== m[3]) return false;
    const claims = JSON.parse(Buffer.from(m[2], "base64url").toString("utf-8"));
    return claims.iss === KEY && claims.exp - claims.iat <= 300;
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = new URL(req.url, "http://amo.test").pathname;
      amo.requests.push(`${req.method} ${path}`);
      const send = (status, json, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(json));
      };
      if (!verifyJwt(req.headers.authorization)) return send(401, { detail: "Incorrect authentication credentials." });

      let m;
      if (req.method === "POST" && path === "/api/v5/addons/upload/") {
        if (amo.rateLimitedUploads > 0) {
          amo.rateLimitedUploads--;
          return send(429, { detail: "Request was throttled. Expected available in 1 second." }, { "Retry-After": "1" });
        }
        const text = body.toString("latin1");
        if (!/name="channel"\r\n\r\nunlisted\r\n/.test(text)) return send(400, { channel: ["This field is required."] });
        if (!/name="upload"; filename="[^"]+\.xpi"/.test(text)) return send(400, { upload: ["Bad file name."] });
        const version = /\{"version":"([^"]+)"/.exec(text)?.[1];
        const uuid = randomBytes(16).toString("hex");
        amo.uploads.set(uuid, { version });
        return send(201, uploadJson(uuid, amo.processedOnCreate));
      }
      if (req.method === "GET" && (m = /^\/api\/v5\/addons\/upload\/(\w+)\/$/.exec(path))) {
        return send(200, uploadJson(m[1], true));
      }
      if (req.method === "PUT" && (m = /^\/api\/v5\/addons\/addon\/([^/]+)\/$/.exec(path))) {
        const guid = decodeURIComponent(m[1]);
        if (amo.putStatus === 403) return send(403, { detail: "You do not have permission to perform this action." });
        if (amo.putStatus === 409) return send(409, { version: ["Duplicate add-on ID found."] });
        const upload = amo.uploads.get(JSON.parse(body.toString("utf-8")).version.upload);
        if (amo.alwaysConflict || amo.usedVersions.has(upload.version)) {
          return send(409, { version: [`Version ${upload.version} already exists.`] });
        }
        amo.usedVersions.add(upload.version);
        const id = amo.nextVersionId++;
        amo.versions.set(id, { guid, version: upload.version, polls: 0 });
        return send(201, { guid, status: "incomplete", version: versionJson(id) });
      }
      if (req.method === "GET" && (m = /^\/api\/v5\/addons\/addon\/([^/]+)\/versions\/(\d+)\/$/.exec(path))) {
        const id = Number(m[2]);
        const v = amo.versions.get(id);
        if (!v || v.guid !== decodeURIComponent(m[1])) return send(404, { detail: "Not found." });
        v.polls++;
        return send(200, versionJson(id));
      }
      if (req.method === "GET" && (m = /^\/firefox\/downloads\/file\/(\d+)\/signed\.xpi$/.exec(path))) {
        res.writeHead(200, { "Content-Type": "application/x-xpinstall" });
        return res.end(Buffer.from(`PK\x03\x04signed ${amo.versions.get(Number(m[1])).version}`, "latin1"));
      }
      if (req.method === "GET" && path === "/api/v5/accounts/profile/") {
        return send(200, { id: 1, name: "Test Developer", username: "testdev" });
      }
      send(404, { detail: "Not found." });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  amo.baseUrl = `http://127.0.0.1:${server.address().port}`;
  amo.close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  amo.count = (prefix) => amo.requests.filter((r) => r.startsWith(prefix)).length;
  return amo;
}

let dirs;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "lavaduct-amo-"));
  process.env.LAVADUCT_STATE_DIR = join(root, "state");
  process.env.LAVADUCT_CACHE_DIR = join(root, "cache");
  dirs = { root, out: join(root, "out"), work: join(root, "work") };
  mkdirSync(dirs.work);
});
afterEach(() => rmSync(dirs.root, { recursive: true, force: true }));

// Packs a stand-in .xpi whose bytes depend on the version and the add-on's contents,
// the way the real packer's output does.
function packer(contents = "v1") {
  const calls = [];
  return {
    calls,
    pack(version) {
      calls.push(version);
      const data = Buffer.from(`PK\x03\x04${JSON.stringify({ version, contents })}`, "latin1");
      const xpiPath = join(dirs.work, "Test Addon.xpi");
      writeFileSync(xpiPath, data);
      return { xpiPath, sha256: createHash("sha256").update(data).digest("hex") };
    },
  };
}

const sign = (amo, packed, extra = {}) =>
  signWithAmo({
    addonId: ADDON_ID,
    baseVersion: "1.0.0",
    credentials: { key: KEY, secret: SECRET },
    pack: packed.pack,
    outDir: dirs.out,
    baseUrl: amo.baseUrl,
    pollMs: 10,
    approvalTimeoutMs: 5000,
    ...extra,
  });

const signedBytes = (outcome) => readFileSync(outcome.signedXpiPath, "latin1");

test("a new add-on is uploaded, submitted, signed and downloaded into the output dir", async (t) => {
  const amo = await startFakeAmo({ processedOnCreate: false, pollsUntilDone: 3 });
  t.after(amo.close);
  const packed = packer();

  const outcome = await sign(amo, packed);

  assert.equal(outcome.kind, "signed");
  assert.equal(outcome.version, "1.0.0");
  assert.equal(outcome.cached, false);
  assert.ok(outcome.signedXpiPath.startsWith(dirs.out), outcome.signedXpiPath);
  assert.equal(signedBytes(outcome), "PK\x03\x04signed 1.0.0");
  assert.deepEqual(packed.calls, ["1.0.0"]);
  assert.equal(amo.count("PUT /api/v5/addons/addon/test-addon%40example.com/"), 1);
});

test("a version AMO already has (409) is bumped in the fourth component and resubmitted", async (t) => {
  const amo = await startFakeAmo({ usedVersions: ["1.0.0"] });
  t.after(amo.close);
  const packed = packer();

  const outcome = await sign(amo, packed);

  assert.equal(outcome.kind, "signed");
  assert.equal(outcome.version, "1.0.0.1");
  assert.deepEqual(packed.calls, ["1.0.0", "1.0.0.1"]);
  assert.equal(signedBytes(outcome), "PK\x03\x04signed 1.0.0.1");
});

test("changed contents under an already-submitted version go straight past every recorded version", async (t) => {
  const amo = await startFakeAmo({ usedVersions: ["1.0.0"] });
  t.after(amo.close);
  await sign(amo, packer("v1"));
  const putsBefore = amo.count("PUT");

  const changed = packer("v2");
  const outcome = await sign(amo, changed);

  assert.equal(outcome.kind, "signed");
  assert.equal(outcome.version, "1.0.0.2");
  assert.deepEqual(changed.calls, ["1.0.0", "1.0.0.2"]);
  assert.equal(amo.count("PUT") - putsBefore, 1, "no 409 round trip for versions already on record");
});

test("conflicts on every version stop after five resubmissions and point at --addon-version", async (t) => {
  const amo = await startFakeAmo({ alwaysConflict: true });
  t.after(amo.close);

  const outcome = await sign(amo, packer());

  assert.equal(outcome.kind, "rejected");
  assert.equal(amo.count("PUT"), 6);
  assert.match(outcome.issues.map((i) => `${i.message} ${i.fix ?? ""}`).join("\n"), /--addon-version/);
});

test("a used four-part version can't be bumped and fails with a hint", async (t) => {
  const amo = await startFakeAmo({ usedVersions: ["1.0.0.5"] });
  t.after(amo.close);

  const outcome = await sign(amo, packer(), { baseVersion: "1.0.0.5" });

  assert.equal(outcome.kind, "rejected");
  assert.equal(amo.count("PUT"), 1);
  assert.match(outcome.issues.map((i) => `${i.message} ${i.fix ?? ""}`).join("\n"), /--addon-version/);
});

test("a version AMO disables is reported as rejected and no signed file is written", async (t) => {
  const amo = await startFakeAmo({ status: "disabled", pollsUntilDone: 2 });
  t.after(amo.close);

  const outcome = await sign(amo, packer());

  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.version, "1.0.0");
  assert.ok(outcome.issues.some((i) => i.severity === "error"));
  assert.ok(!existsSync(dirs.out) || readdirSync(dirs.out).length === 0);
});

test("validation errors come back as amo-validation issues and use up no version", async (t) => {
  const amo = await startFakeAmo({ invalid: true });
  t.after(amo.close);

  const outcome = await sign(amo, packer());

  assert.equal(outcome.kind, "rejected");
  const error = outcome.issues.find((i) => i.severity === "error");
  assert.equal(error.category, "amo-validation");
  assert.equal(error.message, "Unsafe call to eval");
  assert.equal(error.file, "background.js");
  assert.equal(error.line, 3);
  assert.equal(amo.count("PUT"), 0);

  amo.invalid = false;
  const fixed = await sign(amo, packer("fixed"));
  assert.equal(fixed.version, "1.0.0");
});

test("an unchanged add-on is served from the signed cache without contacting AMO", async (t) => {
  const amo = await startFakeAmo();
  t.after(amo.close);
  await sign(amo, packer());
  const requestsBefore = amo.requests.length;

  dirs.out = join(dirs.root, "out-again");
  const outcome = await sign(amo, packer());

  assert.equal(outcome.kind, "signed");
  assert.equal(outcome.cached, true);
  assert.equal(outcome.version, "1.0.0");
  assert.equal(amo.requests.length, requestsBefore);
  assert.ok(outcome.signedXpiPath.startsWith(dirs.out), outcome.signedXpiPath);
  assert.equal(signedBytes(outcome), "PK\x03\x04signed 1.0.0");
});

test("signing that outlasts the approval timeout is pending, and the next run resumes without uploading", async (t) => {
  const amo = await startFakeAmo({ status: "unreviewed" });
  t.after(amo.close);

  const first = await sign(amo, packer(), { approvalTimeoutMs: 100 });
  assert.equal(first.kind, "pending");
  assert.equal(first.version, "1.0.0");
  assert.match(first.statusUrl, /\/versions\/100$/);

  amo.status = "public";
  const seen = amo.requests.length;
  const second = await sign(amo, packer());

  assert.equal(second.kind, "signed");
  assert.equal(second.version, "1.0.0");
  const later = amo.requests.slice(seen);
  assert.ok(!later.some((r) => r.startsWith("POST") || r.startsWith("PUT")), later.join("\n"));
});

test("a pending version that AMO no longer has is replaced by a fresh submission", async (t) => {
  const amo = await startFakeAmo({ status: "unreviewed" });
  t.after(amo.close);
  const first = await sign(amo, packer(), { approvalTimeoutMs: 50 });
  assert.equal(first.kind, "pending");

  amo.versions.clear();
  amo.status = "public";
  const second = await sign(amo, packer());

  assert.equal(second.kind, "signed");
  assert.equal(second.version, "1.0.0.1");
});

test("a 429 is waited out for Retry-After and the request retried", async (t) => {
  const amo = await startFakeAmo({ rateLimitedUploads: 1 });
  t.after(amo.close);

  const started = Date.now();
  const outcome = await sign(amo, packer());

  assert.equal(outcome.kind, "signed");
  assert.equal(amo.count("POST /api/v5/addons/upload/"), 2);
  assert.ok(Date.now() - started >= 1000, "waited for Retry-After");
});

test("a 403 on submission says the add-on ID belongs to another AMO account", async (t) => {
  const amo = await startFakeAmo({ putStatus: 403 });
  t.after(amo.close);

  const outcome = await sign(amo, packer());

  assert.equal(outcome.kind, "rejected");
  assert.match(outcome.issues[0].message, /another AMO account/);
  assert.match(outcome.issues[0].message, new RegExp(ADDON_ID));
});

test("an add-on ID that was deleted on AMO is reported, not bumped around", async (t) => {
  const amo = await startFakeAmo({ putStatus: 409 });
  t.after(amo.close);

  const outcome = await sign(amo, packer());

  assert.equal(outcome.kind, "rejected");
  assert.equal(amo.count("PUT"), 1);
  assert.match(outcome.issues[0].message, /can't be reused/);
  assert.match(outcome.issues[0].fix, /--addon-id/);
});

test("an add-on ID AMO can't accept is refused before anything is uploaded", async (t) => {
  const amo = await startFakeAmo();
  t.after(amo.close);

  const outcome = await sign(amo, packer(), { addonId: `${"x".repeat(80)}@example.com` });

  assert.equal(outcome.kind, "rejected");
  assert.equal(amo.requests.length, 0);
});

test("forgetting an add-on's signed files keeps its version history, so it is signed again under a new version", async (t) => {
  const amo = await startFakeAmo();
  t.after(amo.close);
  await sign(amo, packer());

  removeSignedCache(ADDON_ID);
  const outcome = await sign(amo, packer());

  assert.equal(outcome.kind, "signed");
  assert.equal(outcome.cached, false);
  assert.equal(outcome.version, "1.0.0.1");
  assert.equal(amo.count("PUT"), 2);
});

test("the AMO policy notice is printed on the first AMO run only", async (t) => {
  const amo = await startFakeAmo();
  t.after(amo.close);
  const printed = [];
  const original = console.error;
  console.error = (...args) => printed.push(args.join(" "));
  try {
    await sign(amo, packer());
    const first = printed.splice(0).join("\n");
    await sign(amo, packer("v2"));
    const second = printed.join("\n");

    assert.match(first, /source code/);
    assert.doesNotMatch(second, /source code/);
  } finally {
    console.error = original;
  }
});

test("bumping goes past every recorded fourth component of the same base version", () => {
  assert.equal(bumpFourthComponent("1.2.3", ["1.2.3"]), "1.2.3.1");
  assert.equal(bumpFourthComponent("1.2.3", ["1.2.3", "1.2.3.1", "1.2.3.7", "1.2.4.9"]), "1.2.3.8");
  assert.equal(bumpFourthComponent("1.2", ["1.2"]), "1.2.0.1");
  assert.equal(bumpFourthComponent("1.2.3", ["1.2.2"]), "1.2.3");
});

test("a used four-part version has nothing left to bump", () => {
  assert.equal(bumpFourthComponent("1.2.3.4", ["1.2.3.4"]), null);
});

test("the credential check names the AMO account, or gives AMO's reason for refusing", async (t) => {
  const amo = await startFakeAmo();
  t.after(amo.close);

  const good = await checkAmoCredentials({ key: KEY, secret: SECRET }, amo.baseUrl);
  assert.equal(good.ok, true);
  assert.match(good.detail, /Test Developer/);

  const bad = await checkAmoCredentials({ key: KEY, secret: "wrong" }, amo.baseUrl);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /Incorrect authentication credentials/);
});

test("the credential check reports an unreachable AMO instead of throwing", async () => {
  const amo = await startFakeAmo();
  const { baseUrl } = amo;
  await amo.close();

  const result = await checkAmoCredentials({ key: KEY, secret: SECRET }, baseUrl);

  assert.equal(result.ok, false);
  assert.ok(result.detail.length > 0);
});
