import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { wireBackground, SHIM_FILENAME } from "../dist/runtime/shim.js";

// Bardeen 5.1.0 builds its worker and its pages with separate webpack configs
// that share one chunk global and one file name pattern (`id + ".js"`), so the
// filename template can't tell their chunks apart. Listing all 60 registered
// the pages' modules in the background under ids the worker's own modules use,
// and its Sentry setup called a module that wasn't the one it imported:
// "E.GS is not a function". When the filename is the chunk id between fixed
// strings, only the chunks the worker can reach through `__webpack_require__.e`
// (directly or from a chunk it loads) are listed.

function stage(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "bg-wire-reach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const G = "self.webpackChunkapp";
const chunk = (ids, body = "") => `(${G}=${G}||[]).push([[${ids}],{${String(ids).split(",")[0]}(a,e,r){${body}}}]);`;
const SW = (load) =>
  'var r={f:{},m:{}};r.u=t=>""+t+".js";var t={1:1};r.f.i=(e,n)=>{t[e]||importScripts(r.p+r.u(e))};' +
  `var e=${G}=${G}||[];${load}`;

test("only the chunks the worker can load, and the ones they load, are listed", (t) => {
  const dir = stage(t, {
    "background.js": SW("Promise.all([r.e(10),r.e(20)]).then(r.bind(r,5));"),
    "10.js": chunk(10, "r.e(30).then(()=>{})"),
    "20.js": chunk(20),
    "30.js": chunk(30),
    // the pages' build: same global, same file names
    "40.js": chunk("40,10,20"),
    "popup.js": "var r={};r.e(40);",
  });
  const manifest = { manifest_version: 3, background: { service_worker: "background.js" } };
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background.scripts, [SHIM_FILENAME, "10.js", "20.js", "30.js", "background.js"]);
});

test("a worker that names no chunk keeps every chunk its filename function allows", (t) => {
  const dir = stage(t, {
    "background.js": SW("var id=load();r.e(id);"),
    "10.js": chunk(10),
    "40.js": chunk(40),
  });
  const manifest = { manifest_version: 3, background: { service_worker: "background.js" } };
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background.scripts, [SHIM_FILENAME, "10.js", "40.js", "background.js"]);
});
