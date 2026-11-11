import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageExtension } from "../dist/input/stage.js";

// Staging drops node_modules, README/LICENSE files and the like by name, but Chrome
// serves every file in the package. A file an extension page or script loads by path
// has to survive staging, or it 404s in Firefox.
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "stage-loaded-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test("files that staged pages, stylesheets and scripts load are staged even under excluded names", () => {
  const src = tree({
    "manifest.json": "{}",
    "popup/popup.html":
      '<link rel="stylesheet" href="../node_modules/ui/ui.css"><script src="/node_modules/jquery/jquery.min.js"></script>' +
      "<a href=LICENSE.txt>License</a><script src=\"popup.js\"></script>",
    "popup/popup.js": "// see README.md\n//# sourceMappingURL=popup.js.map\n",
    "popup/popup.js.map": "{}",
    "popup/LICENSE.txt": "MIT",
    "node_modules/jquery/jquery.min.js": "jq",
    "node_modules/ui/ui.css": "@font-face{src:url('fonts/ui%20icons.woff2?v=2')}",
    "node_modules/ui/fonts/ui icons.woff2": "font",
    "sw.js": 'importScripts("node_modules/idb/idb.js", \'./node_modules/x/x.js\');\nimport("./node_modules/m/m.mjs");',
    "node_modules/idb/idb.js": "idb",
    "node_modules/x/x.js": "x",
    "node_modules/m/m.mjs": 'export * from "./dep.mjs";',
    "node_modules/m/dep.mjs": "export const a = 1;",
    "node_modules/unused/index.js": "unused",
    "README.md": "readme",
  });
  const stage = join(mkdtempSync(join(tmpdir(), "stage-loaded-out-")), "stage");
  assert.deepEqual(stageExtension(src, stage, new Set(["sw.js", "popup/popup.html"])), []);

  for (const rel of [
    "node_modules/jquery/jquery.min.js",
    "node_modules/ui/ui.css",
    "node_modules/ui/fonts/ui icons.woff2",
    "popup/LICENSE.txt",
    "node_modules/idb/idb.js",
    "node_modules/x/x.js",
    "node_modules/m/m.mjs",
    "node_modules/m/dep.mjs",
  ]) {
    assert.ok(existsSync(join(stage, rel)), `${rel} should be staged`);
  }
  // Mentions that are not loads leave the exclusions alone.
  assert.ok(!existsSync(join(stage, "README.md")));
  assert.ok(!existsSync(join(stage, "popup/popup.js.map")));
  assert.ok(!existsSync(join(stage, "node_modules/unused")));
});

test("a reference that leaves the package stages nothing from outside it", () => {
  const outer = tree({ "secret.txt": "s", "ext/manifest.json": "{}", "ext/page.html": '<img src="../secret.txt"><img src="/../secret.txt">' });
  const stage = join(mkdtempSync(join(tmpdir(), "stage-loaded-out-")), "stage");
  stageExtension(join(outer, "ext"), stage);
  assert.ok(!existsSync(join(stage, "secret.txt")));
  assert.ok(!existsSync(join(stage, "..", "secret.txt")));
});
