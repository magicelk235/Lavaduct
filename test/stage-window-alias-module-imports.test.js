import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, tempDir } from "./cli-helpers.js";

// A module worker gives itself a window in a module it imports, not in its own
// script: Capital One Shopping's bg.js imports polyfills/index.js, which runs
// `self.window = self`. In the event page window is getter-only, and the throw
// ends the whole module graph, so the rewrite has to follow the static imports.

test("self.window = self goes from the modules a module worker imports", (t) => {
  const src = tempDir(t);
  mkdirSync(join(src, "polyfills"));
  mkdirSync(join(src, "lib"));
  writeFileSync(join(src, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "m", version: "1.0", background: { service_worker: "bg.js", type: "module" } }));
  writeFileSync(join(src, "bg.js"), 'import "./polyfills/index.js";\nimport { x } from "./lib/x.js";\nx();\n');
  writeFileSync(join(src, "polyfills/index.js"), 'import "../lib/deep.mjs";\nself.window = self;\nself.window.devicePixelRatio = undefined;\n');
  writeFileSync(join(src, "lib/x.js"), "export const x = () => 1;\n");
  writeFileSync(join(src, "lib/deep.mjs"), "globalThis.window = globalThis;\n");
  const out = tempDir(t);
  const res = runCli([src, "-o", out, "--no-launch", "--clean"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr + res.stdout);
  const staged = join(out, "staged_extension");
  assert.equal(readFileSync(join(staged, "polyfills/index.js"), "utf-8"), 'import "../lib/deep.mjs";\nself;\nself.window.devicePixelRatio = undefined;\n');
  assert.equal(readFileSync(join(staged, "lib/deep.mjs"), "utf-8"), "globalThis;\n");
  assert.equal(readFileSync(join(staged, "lib/x.js"), "utf-8"), "export const x = () => 1;\n");
});
