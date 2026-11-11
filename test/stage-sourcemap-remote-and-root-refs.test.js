import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripDanglingSourcemaps } from "../dist/input/stage.js";

// Only a sourceMappingURL naming a package file that staging left out dangles. A
// remote map (error trackers host them) and a root-relative path to a map that
// shipped resolve fine in Firefox's devtools and must stay.
test("remote and root-relative source map references that resolve are kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "stage-sourcemap-"));
  mkdirSync(join(dir, "js"));
  mkdirSync(join(dir, "maps"));
  writeFileSync(join(dir, "maps", "b.js.map"), "{}");
  writeFileSync(join(dir, "js", "c.js.map"), "{}");
  const files = {
    "js/a.js": "a()\n//# sourceMappingURL=https://cdn.example.com/a.js.map\n",
    "js/b.js": "b()\n//# sourceMappingURL=/maps/b.js.map\n",
    "js/c.js": "c()\n//# sourceMappingURL=c.js.map?v=3\n",
    "js/d.js": "d()\n//# sourceMappingURL=d.js.map\n",
  };
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text);

  assert.equal(stripDanglingSourcemaps(dir), 1);
  for (const rel of ["js/a.js", "js/b.js", "js/c.js"]) assert.equal(readFileSync(join(dir, rel), "utf-8"), files[rel], rel);
  assert.equal(readFileSync(join(dir, "js/d.js"), "utf-8"), "d()\n\n");
});
