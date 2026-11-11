import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySourceRewrites } from "../dist/input/stage.js";

// The ancestorOrigins guard wraps `<receiver>.ancestorOrigins[0]` in `( … || "")`.
// When the receiver chain continues an index or a call to its left, the walk-back
// stopped at the "." and the wrap split the expression into invalid syntax, which
// kills every line of the script, not just the guarded read.
test("the ancestorOrigins guard never turns a script into a syntax error", () => {
  const dir = mkdtempSync(join(tmpdir(), "stage-ancestor-"));
  const src =
    'var a=frames[0].location.ancestorOrigins[0].includes("x");\n' +
    'var b=f()?.location.ancestorOrigins?.[0].startsWith("y");\n' +
    'var c=window.location.ancestorOrigins[0].includes("z");\n';
  writeFileSync(join(dir, "page.js"), src);
  applySourceRewrites(dir, { manifest_version: 3, name: "T", version: "1" });
  const out = readFileSync(join(dir, "page.js"), "utf-8");
  assert.doesNotThrow(() => new Function(out), out);
  // A plain dotted receiver is still guarded.
  assert.match(out, /var c=\(window\.location\.ancestorOrigins\[0\] \|\| ""\)\.includes\("z"\);/);
});
