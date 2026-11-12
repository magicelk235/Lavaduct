import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { wireBackground, SHIM_FILENAME } from "../dist/runtime/shim.js";

// One webpack config can build the worker and the pages with the same chunk
// global (Hola: self.webpackChunk), so the pages' chunks look exactly like the
// worker's. The worker only ever loads the files its chunk filename function
// names: Hola's is chunkId => "bg." + ({96:"vendors",965:"conf"}[chunkId] || chunkId) + ".bundle.js".
// Listing the pages' chunks in background.scripts too registered their modules
// in the background under the same ids as the worker's (both builds have a chunk
// 96), so the background ran UI modules: "file be_ui_api can only be included in ui".

function stage(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "bg-wire-ui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const chunk = (ids, mod) => `(self["webpackChunk"]=self["webpackChunk"]||[]).push([[${ids}],{${mod}(e,t,r){}}]);`;

const SW =
  '(()=>{var __webpack_require__={f:{},m:{}};' +
  '__webpack_require__.u=chunkId=>"bg."+({96:"vendors",965:"conf"}[chunkId]||chunkId)+".bundle.js";' +
  'var installedChunks={130:1};__webpack_require__.f.i=(chunkId,promises)=>{if(!installedChunks[chunkId])importScripts(__webpack_require__.p+__webpack_require__.u(chunkId))};' +
  'var chunkLoadingGlobal=self["webpackChunk"]=self["webpackChunk"]||[];})();';

test("only the chunks the worker's filename function can name are listed", (t) => {
  const dir = stage(t, {
    "js/bg.bg.bundle.js": SW,
    "js/bg.379.bundle.js": chunk(379, 1),
    "js/bg.vendors.bundle.js": chunk(96, 2),
    "js/bg.conf.bundle.js": chunk(965, 3),
    // the pages' build, same chunk global
    "js/439.bundle.js": chunk(439, 4),
    "js/vendors.bundle.js": chunk(96, 5),
    "js/conf.bundle.js": chunk(965, 6),
  });
  const manifest = { manifest_version: 3, background: { service_worker: "js/bg.bg.bundle.js" } };
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background.scripts, [SHIM_FILENAME, "js/bg.379.bundle.js", "js/bg.conf.bundle.js", "js/bg.vendors.bundle.js", "js/bg.bg.bundle.js"]);
});

test("chunks under the folder the filename function names are kept, others left out", (t) => {
  const dir = stage(t, {
    "sw.js": 'var r={f:{}};r.u=e=>"chunks/"+e+"."+{1:"aa",2:"bb"}[e]+".js";var e={};r.f.i=(t,n)=>{e[t]||importScripts(r.p+r.u(t))};var t=globalThis.webpackChunk=globalThis.webpackChunk||[];',
    "chunks/1.aa.js": "(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[1],{1(e){}}]);",
    "chunks/2.bb.js": "(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[2],{2(e){}}]);",
    "other/3.js": "(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[3],{3(e){}}]);",
  });
  const manifest = { manifest_version: 3, background: { service_worker: "sw.js" } };
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background.scripts, [SHIM_FILENAME, "chunks/1.aa.js", "chunks/2.bb.js", "sw.js"]);
});
