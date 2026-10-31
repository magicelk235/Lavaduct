import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { wireBackground, SHIM_FILENAME } from "../dist/runtime/shim.js";

// Firefox has no background service worker: an SW-only manifest fails to load
// ("background.service_worker is currently disabled. Add background.scripts.").
// The worker has to run as an event page from background.scripts, where
// importScripts() does not exist.

function stage(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "bg-wire-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const read = (dir, f) => readFileSync(join(dir, f), "utf-8");
const callsImportScripts = (src) => /\bimportScripts\s*\(/.test(src);

test("an SW's importScripts targets load ahead of it from background.scripts, and the call is neutralised", (t) => {
  const dir = stage(t, {
    "sw.js": 'importScripts("a.js");\nchrome.runtime.onMessage.addListener(() => A);\n',
    "a.js": "var A = 1;\n",
  });
  const manifest = { manifest_version: 3, background: { service_worker: "sw.js" } };
  const res = wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, "a.js", "sw.js"] });
  assert.deepEqual(res, { converted: true, hoisted: ["a.js"] });
  const sw = read(dir, "sw.js");
  assert.ok(!callsImportScripts(sw), sw);
  assert.match(sw, /chrome\.runtime\.onMessage\.addListener/, "the rest of the worker is untouched");
});

test("a module service worker keeps type: module and nothing is hoisted", (t) => {
  const src = 'import { start } from "./lib/start.js";\nimport "./polyfills.js";\nstart();\n';
  const dir = stage(t, {
    "bg/sw.js": src,
    "bg/lib/start.js": "export function start() {}\n",
    "bg/polyfills.js": "",
  });
  const manifest = { manifest_version: 3, background: { service_worker: "bg/sw.js", type: "module" } };
  const res = wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, "bg/sw.js"], type: "module" });
  assert.deepEqual(res, { converted: true, hoisted: [] });
  assert.equal(read(dir, "bg/sw.js"), src, "static imports resolve natively; the source must not change");
});

test("a root-absolute target in a worker that lives in a subdirectory resolves from the extension root", (t) => {
  const dir = stage(t, {
    "src/service_worker.js": 'importScripts("/src/lib/actions.js", "lib/providers.js");\n',
    "src/lib/actions.js": "var Actions = {};\n",
    "src/lib/providers.js": "var Providers = {};\n",
  });
  const manifest = { manifest_version: 3, background: { service_worker: "src/service_worker.js" } };
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background.scripts, [
    SHIM_FILENAME, "src/lib/actions.js", "src/lib/providers.js", "src/service_worker.js",
  ]);
});

test("a loop over a literal list hoists every listed script in order, and a hoisted file's own imports come first", (t) => {
  const dir = stage(t, {
    "bg.js":
      'var scriptsToImport = [\n  "lib/a.js",\n  \'b.js\', // core\n  "background.js"\n];\n' +
      "for (let script of scriptsToImport) {\n  self.importScripts('./' + script);\n}\n",
    "lib/a.js": 'importScripts("lib/dep.js");\nvar A = 1;\n',
    "lib/dep.js": "var DEP = 1;\n",
    "b.js": "var B = 2;\n",
    "background.js": "var C = 3;\n",
  });
  const manifest = { manifest_version: 3, background: { service_worker: "bg.js" } };
  const res = wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background.scripts, [
    SHIM_FILENAME, "lib/dep.js", "lib/a.js", "b.js", "background.js", "bg.js",
  ]);
  assert.deepEqual(res.hoisted, ["lib/dep.js", "lib/a.js", "b.js", "background.js"]);
  assert.ok(!callsImportScripts(read(dir, "bg.js")));
  assert.ok(!callsImportScripts(read(dir, "lib/a.js")), "nested calls are neutralised too");
});

// Minified webpack worker runtime (MetaMask's shape): its chunk loader calls
// importScripts with a computed URL and installs chunks pushed after it loads.
const SW_WEBPACK =
  'var r={f:{}};r.u=e=>e+".js";' +
  'var e={5864:1};r.f.i=(t,n)=>{e[t]||importScripts(r.p+r.u(t))};' +
  "var t=globalThis.webpackChunk=globalThis.webpackChunk||[],n=t.push.bind(t);" +
  "t.push=t=>{var[i,s,a]=t;for(var o in s)r.m[o]=s[o];for(a&&a(r);i.length;)e[i.pop()]=1;n(t)};";

test("a webpack worker's async chunks are listed ahead of it, for the shim to hand to its chunk loader", (t) => {
  const files = {
    "sw.js": SW_WEBPACK,
    "123.abc.js": '"use strict";(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[123],{1(e,t,r){}}]);',
    "456.def.js": "/*! license */(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[456],{2(e,t,r){}}]);\n//# sourceMappingURL=456.def.js.map",
    // a third element is an entry's startup callback: loading it would boot that entry
    "entry.js": "(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[9],{3(e){}},r=>{r(3)}]);",
    // another bundle's chunk global
    "ui.js": "(globalThis.webpackChunkui=globalThis.webpackChunkui||[]).push([[7],{4(e){}}]);",
    // real code ahead of the push makes it an entry script
    "boot.js": 'console.log("hi");(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[8],{5(e){}}]);',
  };
  const dir = stage(t, files);
  const manifest = { manifest_version: 3, background: { service_worker: "sw.js" } };
  const res = wireBackground(dir, manifest, SHIM_FILENAME);
  // Startup code can require a chunk a microtask after asking for it, as importScripts allows.
  assert.deepEqual(manifest.background.scripts, [SHIM_FILENAME, "123.abc.js", "456.def.js", "sw.js"]);
  assert.deepEqual(res.hoisted, []);
  assert.ok(!callsImportScripts(read(dir, "sw.js")), "the dynamic call is neutralised as well");

  // Without the shim nothing replays chunks queued before the runtime, so they go after it.
  const bare = { manifest_version: 3, background: { service_worker: "sw.js" } };
  wireBackground(stage(t, files), bare);
  assert.deepEqual(bare.background.scripts, ["sw.js", "123.abc.js", "456.def.js"]);
});

test("existing background scripts get the shim prepended once", (t) => {
  const dir = stage(t, { "bg.js": "" });
  const manifest = { manifest_version: 2, background: { scripts: ["bg.js"], persistent: false } };
  assert.deepEqual(wireBackground(dir, manifest, SHIM_FILENAME), { converted: false, hoisted: [] });
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, "bg.js"], persistent: false });
});

test("a manifest that already lists scripts for Firefox keeps them and drops service_worker", (t) => {
  const dir = stage(t, { "bg.js": 'importScripts("x.js");' , "x.js": "" });
  const manifest = { manifest_version: 3, background: { service_worker: "bg.js", scripts: ["bg.js"] } };
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, "bg.js"] });
});

test("a background page is left alone", (t) => {
  const dir = stage(t, { "bg.html": "<script src=bg.js></script>", "bg.js": "" });
  const manifest = { manifest_version: 2, background: { page: "bg.html" } };
  assert.deepEqual(wireBackground(dir, manifest, SHIM_FILENAME), { converted: false, hoisted: [] });
  assert.deepEqual(manifest.background, { page: "bg.html" });
});

test("without a shim file the worker still becomes background.scripts", (t) => {
  const dir = stage(t, { "sw.js": "self.x = 1;" });
  const manifest = { manifest_version: 3, background: { service_worker: "/sw.js" } };
  wireBackground(dir, manifest);
  assert.deepEqual(manifest.background, { scripts: ["sw.js"] });
});
