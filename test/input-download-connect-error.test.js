import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { lookup } from "node:dns/promises";
import { downloadExtension } from "../dist/input/download.js";
import { runCliAsync, tempDir } from "./cli-helpers.js";

// Node tries every address a host name resolves to (happy eyeballs), and when
// all of them fail it rejects with an AggregateError whose own message is
// empty. The download passed that straight up, so the CLI printed a bare "✗"
// for a store download that timed out or a host that refused the connection.

async function closedPort() {
  const srv = createServer().listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address();
  srv.close();
  await once(srv, "close");
  return port;
}

test("a refused connection to every address names the URL and the reasons", async (t) => {
  const addrs = await lookup("localhost", { all: true });
  if (addrs.length < 2) return t.skip("localhost resolves to a single address here");
  const url = `http://localhost:${await closedPort()}/ext.crx`;
  await assert.rejects(downloadExtension(url, tempDir(t)), (e) => {
    assert.ok(e.message.length > 0, "empty error message");
    assert.ok(e.message.includes(url), e.message);
    assert.match(e.message, /ECONNREFUSED/);
    return true;
  });
});

test("the CLI prints the reason, not a bare ✗", async (t) => {
  const url = `http://localhost:${await closedPort()}/ext.crx`;
  const res = await runCliAsync([url, "-o", tempDir(t), "--no-launch"], { state: tempDir(t) });
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr + res.stdout, /✗ .*ECONNREFUSED/);
});
