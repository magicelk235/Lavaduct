import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { wireBackground, SHIM_FILENAME } from "../dist/runtime/shim.js";

// Sentry's bundler plugin puts a debug-ID snippet at the top of every file it
// emits, webpack chunks included, ahead of the chunk's push. A chunk was only
// recognised when nothing but comments and "use strict" came before the push,
// so a worker's chunks went unlisted while its importScripts was neutralized:
// Bardeen 5.1.0's background required modules that never arrived ("can't
// access property "call", t[n] is undefined"), its engine never loaded, and its
// sidebar answered every request with "Engine is still loading".

function stage(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "bg-wire-sentry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const ID = "48d4c328-b126-58db-a521-3c9f9fa1c3b7";
// The snippet as Bardeen ships it, and the plugin's other form, with the identifier and a leading ";".
const SENTRY = `\n!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="${ID}")}catch(e){}}();\n`;
const SENTRY_ID = `;!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="${ID}",e._sentryDebugIdIdentifier="sentry-dbid-${ID}")}catch(e){}}();`;
const G = "self.webpackChunkbardeen_browser_extension";
const chunk = (id) => `(${G}=${G}||[]).push([[${id}],{${id}(a,e){}}]);\n//# debugId=${ID}\n`;

const SW =
  SENTRY +
  'var r={f:{},m:{}};r.u=t=>""+t+".js";var t={6471:1};r.f.i=(e,n)=>{t[e]||importScripts(r.p+r.u(e))};' +
  `var e=${G}=${G}||[];`;

test("chunks that start with Sentry's debug-ID snippet are listed ahead of the worker", (t) => {
  const dir = stage(t, {
    "background.js": SW,
    "3850.js": SENTRY + chunk(3850),
    "9615.js": SENTRY_ID + "\n" + chunk(9615),
    "1013.js": "\"use strict\";" + SENTRY + chunk(1013),
  });
  const manifest = { manifest_version: 3, background: { service_worker: "background.js" } };
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background.scripts, [SHIM_FILENAME, "1013.js", "3850.js", "9615.js", "background.js"]);
});

test("other code ahead of the push still keeps a file out", (t) => {
  const dir = stage(t, {
    "background.js": SW,
    "1.js": SENTRY + "doSomething();" + chunk(1),
    "2.js": "!function(){try{doSomething()}catch(e){}}();" + chunk(2),
    "3.js": SENTRY + chunk(3),
  });
  const manifest = { manifest_version: 3, background: { service_worker: "background.js" } };
  wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background.scripts, [SHIM_FILENAME, "3.js", "background.js"]);
});
