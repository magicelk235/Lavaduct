import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyOAuthBridge } from "../dist/runtime/oauth-bridge.js";
import { wireBackground, SHIM_FILENAME } from "../dist/runtime/shim.js";

// The bridge puts its importScripts call after a classic worker's directive
// prologue, and wireBackground leaves `void 0` where the call was. A
// "use strict" without a semicolon, followed by a comment, must still count as
// the prologue, or the worker silently loses strict mode.

const WORKERS = {
  "a comment on the next line": '"use strict"\n// strict from here on\nself.ran = true;\n',
  "a comment on the same line": "'use strict' // eslint-disable-line\nself.ran = true;\n",
  "a block comment on the next line": "'use strict'\n/* setup */\nself.ran = true;\n",
};

for (const [what, source] of Object.entries(WORKERS)) {
  test(`a worker whose "use strict" has no semicolon and ${what} stays strict`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-directive-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "sw.js"), source);
    const manifest = {
      manifest_version: 3, name: "T", version: "1",
      background: { service_worker: "sw.js" },
      externally_connectable: { matches: ["https://app.example.com/*"] },
    };
    applyOAuthBridge(dir, manifest, "abcdefghijklmnopabcdefghijklmnop");
    wireBackground(dir, manifest, SHIM_FILENAME);
    const worker = readFileSync(join(dir, "sw.js"), "utf-8");
    const self = {};
    const strict = vm.runInNewContext(`${worker}\n;(function () { return this === undefined; })()`, { self });
    assert.equal(self.ran, true, worker);
    assert.equal(strict, true, worker);
  });
}

test("a string that the next line continues is not a directive", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-directive-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "sw.js"), '"use strict"\n// joined below\n+ "";\nself.ran = true;\n');
  const manifest = {
    manifest_version: 3, name: "T", version: "1",
    background: { service_worker: "sw.js" },
    externally_connectable: { matches: ["https://app.example.com/*"] },
  };
  applyOAuthBridge(dir, manifest, "abcdefghijklmnopabcdefghijklmnop");
  const worker = readFileSync(join(dir, "sw.js"), "utf-8");
  assert.ok(worker.startsWith("importScripts("), worker);
});
