import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { runCli, runCliAsync, tempDir } from "./cli-helpers.js";

// --analyze --json answers in JSON whatever stops it from reading the input, so
// a consumer piping it into a parser never gets an empty stdout.
function assertJsonError(res) {
  assert.equal(res.code, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.convertible, false);
  assert.equal(typeof out.error, "string");
  assert.ok(out.error.length > 0);
}

test("--analyze --json reports a missing input as JSON", (t) => {
  const res = runCli([join(tempDir(t), "missing.zip"), "--analyze", "--json"], { state: tempDir(t) });
  assertJsonError(res);
  assert.match(JSON.parse(res.stdout).error, /Input not found/);
});

test("--analyze --json reports a failed download as JSON", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/ext.crx`;
  assertJsonError(await runCliAsync([url, "--analyze", "--json"], { state: tempDir(t) }));
});
