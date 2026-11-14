import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { wireBackground, SHIM_FILENAME } from "../dist/runtime/shim.js";

// A worker can reach importScripts without calling it by name: through apply or
// call, or through a function that forwards its arguments to it, like Closure's safe
// importScripts (safevalues' workerGlobalScopeImportScripts). Google Dictionary
// loads mustache.js that way, behind `self instanceof WorkerGlobalScope`, so in
// Firefox's event page (no importScripts, not a worker) the library never loaded and
// every lookup failed on "Mustache is not defined". The targets these calls name are
// hoisted into background.scripts like a literal importScripts call's, and the calls
// are neutralised.

function stage(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "bg-wire-indirect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const read = (dir, f) => readFileSync(join(dir, f), "utf-8");
const reachesImportScripts = (src) => /\bimportScripts\s*(?:\.\s*(?:apply|call)\s*)?\(/.test(src);

// Google Dictionary 4.2.6's background.min.js, cut down to the parts on the path:
// Closure's template-tag helpers, the TrustedResourceUrl type, the safe
// importScripts and its one call, gated on running in a worker.
const GDICT_WORKER =
  'var ca=function(a){return Array.prototype.slice.call(a)};function G(){for(var a=Number(this),b=[],c=a;c<arguments.length;c++)b[c-a]=arguments[c];return b}\n' +
  "var x=function(a,b){a.raw=b;Object.freeze&&(Object.freeze(a),Object.freeze(b));\nreturn a},y=function(a){return x(a,a)};\n" +
  "var K=function(a){this.M=a};K.prototype.toString=function(){return this.M+\"\"};function wa(a){return new K(a)}\n" +
  'function za(a){var b=G.apply(1,arguments);if(!Array.isArray(a)||b.length+1!==a.length)throw new TypeError("template tag");return wa(a[0])}\n' +
  'function Aa(a){a.importScripts.apply(a,ca(G.apply(1,arguments).map(function(b){if(b instanceof K)b=b.M;else throw Error("Unexpected type when unwrapping TrustedResourceUrl");return b})))};\n' +
  'var Ba=y(["mustache.js"]);typeof WorkerGlobalScope!=="undefined"&&self instanceof WorkerGlobalScope&&Aa(self,za(Ba));\n' +
  "var templates=Mustache.render(\"{{w}}\",{w:\"ok\"});\n";
const MUSTACHE = "(function(g){g.Mustache={render:function(t,v){return v.w}}})(this);\n";

function runBackground(dir, scripts, extra = {}) {
  const ctx = vm.createContext({ ...extra });
  ctx.self = ctx;
  for (const s of scripts) if (s !== SHIM_FILENAME) vm.runInContext(read(dir, s), ctx, { filename: s });
  return ctx;
}

test("Closure's safe importScripts: the forwarded target is hoisted and the forwarder neutralised", (t) => {
  const dir = stage(t, { "background.min.js": GDICT_WORKER, "mustache.js": MUSTACHE, "content.min.js": "x();\n" });
  const manifest = { manifest_version: 3, background: { service_worker: "background.min.js" } };
  const res = wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background, { scripts: [SHIM_FILENAME, "mustache.js", "background.min.js"] });
  assert.deepEqual(res, { converted: true, hoisted: ["mustache.js"] });
  const sw = read(dir, "background.min.js");
  assert.ok(!reachesImportScripts(sw), sw);
  // The event page is not a worker, so the gate stays shut and Mustache comes from
  // the hoisted script; were the gate open, the neutralised forwarder must not throw.
  assert.equal(runBackground(dir, manifest.background.scripts).templates, "ok");
  function WorkerGlobalScope() {}
  const asWorker = runBackground(dir, manifest.background.scripts, { WorkerGlobalScope });
  Object.setPrototypeOf(asWorker, WorkerGlobalScope.prototype);
  assert.doesNotThrow(() => vm.runInContext(read(dir, "background.min.js"), asWorker));
});

test("importScripts through call, or through apply with an array literal, hoists its literal targets", (t) => {
  const dir = stage(t, {
    "sw.js": 'self.importScripts.call(self, "a.js", "lib/b.js");\nimportScripts.apply(self, ["c.js"]);\nvar S = A + B + C;\n',
    "a.js": "var A = 1;\n",
    "lib/b.js": "var B = 2;\n",
    "c.js": "var C = 3;\n",
  });
  const manifest = { manifest_version: 3, background: { service_worker: "sw.js" } };
  const res = wireBackground(dir, manifest, SHIM_FILENAME);
  assert.deepEqual(manifest.background.scripts, [SHIM_FILENAME, "a.js", "lib/b.js", "c.js", "sw.js"]);
  assert.deepEqual(res.hoisted, ["a.js", "lib/b.js", "c.js"]);
  const sw = read(dir, "sw.js");
  assert.ok(!reachesImportScripts(sw), sw);
  assert.equal(runBackground(dir, manifest.background.scripts).S, 6);
});

test("a forwarded URL that isn't one literal, or a forwarder nobody calls, hoists nothing", (t) => {
  const forwarder = 'function Aa(a){a.importScripts.apply(a,G.apply(1,arguments).map(unwrap))}\n';
  for (const [name, sw] of [
    ["template with an interpolation", forwarder + 'var Ba=y(["locale/",".js"]);Aa(self,za(Ba,lang));\n'],
    ["computed name", forwarder + 'Aa(self,za(y([base+"a.js"])));\n'],
    ["unresolved variable", forwarder + "Aa(self,url);\n"],
    ["never called", forwarder + 'safevalues.workerGlobalScopeImportScripts=Aa;chrome.scripting.executeScript({files:["a.js"]});\n'],
  ]) {
    const dir = stage(t, { "sw.js": sw, "a.js": "x();\n", "locale/.js": "x();\n" });
    const manifest = { manifest_version: 3, background: { service_worker: "sw.js" } };
    const res = wireBackground(dir, manifest, SHIM_FILENAME);
    assert.deepEqual(res, { converted: true, hoisted: [] }, name);
    assert.deepEqual(manifest.background.scripts, [SHIM_FILENAME, "sw.js"], name);
    assert.ok(!reachesImportScripts(read(dir, "sw.js")), `${name}: the call is still neutralised`);
  }
});
