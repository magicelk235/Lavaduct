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
  return scanExtension(dir, manifest, MIN).filter((i) => i.category === "background" && /indirectly/.test(i.message));
}

// Google Dictionary's worker loads mustache.js with Closure's safe importScripts,
//   function Aa(a){a.importScripts.apply(a, urls.map(unwrap))}
// which the converter can't hoist and the analyzer used to pass over in silence, so
// the report said nothing while every lookup threw "Mustache is not defined".
test("importScripts called through apply, call, bind, an alias or a bracketed name is a warning", (t) => {
  for (const sw of [
    "function Aa(a){a.importScripts.apply(a,ca(urls))}\nAa(self,za(Ba));\n",
    "self.importScripts.call(self, url);\n",
    "const load = self.importScripts.bind(self); load(u);\n",
    "var imp = self.importScripts; imp(u);\n",
    'self["importScripts"](u);\n',
  ]) {
    const found = scan(t, sw);
    assert.equal(found.length, 1, sw);
    assert.equal(found[0].severity, "warning");
    assert.equal(found[0].file, "sw.js");
  }
});

test("a direct call, a typeof probe, or a module worker gets no indirect-call warning", (t) => {
  assert.deepEqual(scan(t, 'importScripts("a.js");\nif (typeof importScripts === "function") x();\n'), []);
  assert.deepEqual(scan(t, "self.importScripts.apply(self, u);\n", { ...CLASSIC, background: { service_worker: "sw.js", type: "module" } }), []);
});
