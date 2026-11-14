import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanExtension } from "../dist/analyze/analyze.js";

const MIN = { minFirefox: "153.0" };
const CLASSIC = { manifest_version: 3, name: "W", version: "1", background: { service_worker: "sw.js" } };

function scan(t, sw, manifest = CLASSIC) {
  const dir = mkdtempSync(join(tmpdir(), "analyze-is-indirect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "sw.js"), sw);
  return scanExtension(dir, manifest, MIN).filter((i) => i.category === "background" && /importScripts/.test(i.message));
}

// importScripts reached as a value (bound, aliased, looked up by a bracketed name)
// is never found by the converter, so its targets are never hoisted.
test("importScripts reached through bind, an alias or a bracketed name is a warning", (t) => {
  for (const sw of [
    "const load = self.importScripts.bind(self); load(u);\n",
    "var imp = self.importScripts; imp(u);\n",
    'self["importScripts"](u);\n',
  ]) {
    const found = scan(t, sw);
    assert.equal(found.length, 1, sw);
    assert.equal(found[0].severity, "warning");
    assert.match(found[0].message, /indirectly/);
    assert.equal(found[0].file, "sw.js");
  }
});

// Calls through call or apply, and Closure's safe importScripts (Google Dictionary's
//   function Aa(a){a.importScripts.apply(a, urls.map(unwrap))}
// fed `za(y(["mustache.js"]))`), are hoisted when every URL comes down to a literal,
// and warn like any computed importScripts argument when one doesn't.
test("importScripts through call, apply or a forwarding function is hoisted when its URLs are literals", (t) => {
  for (const sw of [
    'self.importScripts.call(self, "a.js");\n',
    'importScripts.apply(self, ["a.js"]);\n',
    'function Aa(a){a.importScripts.apply(a,ca(G.apply(1,arguments).map(unwrap)))}\nvar Ba=y(["a.js"]);self instanceof WorkerGlobalScope&&Aa(self,za(Ba));\n',
  ]) {
    const found = scan(t, sw);
    assert.equal(found.length, 1, sw);
    assert.equal(found[0].severity, "info", sw);
    assert.match(found[0].message, /auto-hoisted/, sw);
  }
  for (const sw of [
    "self.importScripts.call(self, url);\n",
    "function Aa(a){a.importScripts.apply(a,ca(urls))}\nAa(self,za(Ba));\n",
  ]) {
    const found = scan(t, sw);
    assert.equal(found.length, 1, sw);
    assert.equal(found[0].severity, "warning", sw);
    assert.match(found[0].message, /dynamic/, sw);
  }
});

test("a direct call, a typeof probe, or a module worker gets no indirect-call warning", (t) => {
  assert.deepEqual(scan(t, 'importScripts("a.js");\nif (typeof importScripts === "function") x();\n').filter((i) => /indirectly/.test(i.message)), []);
  assert.deepEqual(scan(t, "self.importScripts.apply(self, u);\n", { ...CLASSIC, background: { service_worker: "sw.js", type: "module" } }), []);
});
