import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySourceRewrites } from "../dist/input/stage.js";
import { runCli, tempDir } from "./cli-helpers.js";

// A worker reaches its global through a name the bundler gave it, not only
// through self: webpack 4 wraps a module in `(function(e){ e.window = {} }).call(this,
// r(58))`, where module 58 returns the global (BlockSite's service worker), and
// webpack 5 hands it out as `__webpack_require__.g` (NaturalReader's Amplify
// bundle: `n.g.window = self`). In the event page window is a getter-only
// accessor, and the strict-mode assignment throws, ending the background there.

// Run a script with `globalThis`, `self` and `this` bound to a stand-in global.
// In the event page's realm window is an own, non-configurable getter (a vm
// context's global can't model that: its interceptor swallows the throw).
function run(code, { eventPage }) {
  const G = {};
  if (eventPage) Object.defineProperty(G, "window", { get() { return G; }, enumerable: true, configurable: false });
  new Function("globalThis", "self", code).call(G, G, G);
  return G;
}

const WORKER = [
  '"use strict";',
  "(function (e) { e.window = {}; globalThis.reached1 = true; }).call(this, globalThis);",
  "var n = { g: globalThis }; n.g.window = self; globalThis.reached2 = true;",
  "var other = { g: {} }; other.g.window = self; globalThis.otherWindowIsSelf = other.g.window === self;",
  "var o = {}; var v = o.window = 5; globalThis.chained = v === 5 && o.window === 5;",
  "if (n.g.window == self) globalThis.compared = true;",
].join("\n");

test("a worker's window assignment through a bundler's global alias doesn't throw in the event page", () => {
  assert.throws(() => run(WORKER, { eventPage: true }), /getter/, "the unrewritten worker throws, or the test proves nothing");

  const dir = mkdtempSync(join(tmpdir(), "stage-window-alias-"));
  writeFileSync(join(dir, "sw.js"), WORKER);
  writeFileSync(join(dir, "page.js"), WORKER);
  applySourceRewrites(dir, { manifest_version: 3, name: "T", version: "1", background: { service_worker: "sw.js" } });
  const rewritten = readFileSync(join(dir, "sw.js"), "utf-8");
  assert.equal(readFileSync(join(dir, "page.js"), "utf-8"), WORKER, "only the background's own scripts change");

  const ctx = run(rewritten, { eventPage: true });
  assert.equal(ctx.reached1, true, "the webpack 4 global parameter's assignment no longer ends the module");
  assert.equal(ctx.reached2, true, "the webpack 5 __webpack_require__.g assignment no longer ends the script");
  assert.equal(ctx.otherWindowIsSelf, true, "an object that isn't the global still gets its window");
  assert.equal(ctx.chained, true, "the assignment's value and target are unchanged elsewhere");
  assert.equal(ctx.compared, true, "comparisons aren't touched");
  assert.equal(ctx.window, ctx, "the event page keeps its own window");

  // In a real worker, where window is an ordinary property, the guard changes
  // nothing the worker can see except the global's own window.
  const worker = run(rewritten, { eventPage: false });
  assert.equal(worker.reached1 && worker.reached2 && worker.otherWindowIsSelf && worker.chained, true);
});

// The same assignment in a script the worker pulls in with importScripts, which
// lavaduct hoists into background.scripts after the staging rewrites have run.
test("a window assignment in a hoisted importScripts target is guarded too", (t) => {
  const src = tempDir(t);
  writeFileSync(join(src, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "m", version: "1.0", background: { service_worker: "sw.js" } }));
  writeFileSync(join(src, "sw.js"), 'importScripts("lib/amplify.js");\n');
  mkdirSync(join(src, "lib"));
  const lib = '"use strict";var n={g:self};n.g.window=self;globalThis.reached=true;\n';
  writeFileSync(join(src, "lib/amplify.js"), lib);
  const out = tempDir(t);
  const res = runCli([src, "-o", out, "--no-launch", "--clean"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr + res.stdout);
  const staged = readFileSync(join(out, "staged_extension", "lib/amplify.js"), "utf-8");
  assert.throws(() => run(lib, { eventPage: true }), /getter/);
  assert.equal(run(staged, { eventPage: true }).reached, true, staged);
});
