import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The Viaduct app's persist helper bundles these modules into one file that
// sits alone in the app (docs/design.md, "Modules persist imports from dist/").
// paths.js finds templates/ and runtime/ relative to itself, and nothing is
// next to the bundle, so none of them may reach it. lavaduct 0.1.4 broke this
// when input/stage.js started importing runtime/shim.js for its JS scanner.
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PERSIST_IMPORTS = [
  "firefox/install.js", "firefox/launch.js", "firefox/locate.js", "firefox/native-hosts.js",
  "firefox/platform/index.js", "firefox/platform/shared.js", "firefox/profiles.js", "firefox/rdp.js",
  "manifest/manifest.js", "name.js", "state.js", "util.js",
];
// tsc emits each static import/export on its own line; anything else that
// looks like an import (inside a string or a regex) isn't one.
const IMPORT_RE = /^\s*(?:import|export)\b[^\n]*?["'](\.{1,2}\/[^"']+)["']/gm;

/** Every dist module reachable from `entry`, mapped to the module that first imported it. */
function importGraph(entry) {
  const seen = new Map([[resolve(DIST, entry), null]]);
  const queue = [resolve(DIST, entry)];
  while (queue.length) {
    const file = queue.shift();
    for (const [, spec] of readFileSync(file, "utf-8").matchAll(IMPORT_RE)) {
      const dep = resolve(dirname(file), spec);
      if (seen.has(dep)) continue;
      seen.set(dep, file);
      queue.push(dep);
    }
  }
  return seen;
}

test("no module persist bundles reaches paths.js", () => {
  const paths = resolve(DIST, "paths.js");
  for (const entry of PERSIST_IMPORTS) {
    const graph = importGraph(entry);
    if (!graph.has(paths)) continue;
    const chain = [];
    for (let at = paths; at; at = graph.get(at)) chain.unshift(relative(DIST, at));
    assert.fail(`${entry} reaches paths.js: ${chain.join(" → ")}`);
  }
});
