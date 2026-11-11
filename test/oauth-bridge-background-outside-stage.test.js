import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyOAuthBridge } from "../dist/runtime/oauth-bridge.js";

// The manifest is untrusted. A background worker or page path that leads out
// of the staged directory must not get the receiver written into whatever file
// sits there on the user's disk.

const BACKGROUNDS = {
  "a classic worker": { service_worker: "../victim.js" },
  "a worker named from the root": { service_worker: "/../victim.js" },
  "a module worker": { service_worker: "../victim.js", type: "module" },
  "a background page": { page: "../victim.html" },
  "a background page named from the root": { page: "/../victim.html" },
};

for (const [what, background] of Object.entries(BACKGROUNDS)) {
  test(`${what} outside the staged directory is left alone`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "bridge-outside-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stage = join(root, "staged_extension");
    mkdirSync(stage);
    const victims = { "victim.js": 'console.log("mine");\n', "victim.html": "<html><head></head><body>mine</body></html>" };
    for (const [name, content] of Object.entries(victims)) writeFileSync(join(root, name), content);

    applyOAuthBridge(stage, {
      manifest_version: 3, name: "T", version: "1", background,
      externally_connectable: { matches: ["https://app.example.com/*"] },
    }, "abcdefghijklmnopabcdefghijklmnop");

    for (const [name, content] of Object.entries(victims)) assert.equal(readFileSync(join(root, name), "utf-8"), content, name);
  });
}
