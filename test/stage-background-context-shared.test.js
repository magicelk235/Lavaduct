import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, tempDir } from "./cli-helpers.js";
import { EXT_ORIGIN, fakeBrowser, runInContext } from "./shim-sandbox.js";

// A bundle tells its service worker from its pages with checks that only hold in
// a worker, and the converted worker runs in an event page where they don't:
//   - Hola: is_bg = () => location.pathname == "/js/bg.html" || location.pathname == "/js/sw.js"
//     (the event page's path is /_generated_background_page.html);
//   - Total Adblock: static isBackground() { return "undefined" == typeof document }
//     (the event page has a document);
//   - `if (typeof window === "undefined") return "background"`, already rewritten
//     in the worker's own script, but not in the files its importScripts loads.
// Those files are the worker's chunks, and its pages load them too, so the check
// must still say no there: in them it gains `|| <background flag>`, which only
// the background's shim sets.

const LIB = `var R = {
  hola: (function () { var E = {}; E.is_bg = () => location.pathname == "/js/bg.html" || location.pathname == "/js/sw.js"; return E.is_bg(); })(),
  adblock: (function () { class C { static isBackground() { var e; return 2 === M.manifest_version ? false : "undefined" == typeof document; } } return C.isBackground(); })(),
  kind: (function () { if (typeof window === "undefined") return "background"; return "page"; })(),
};
`;

function convert(t) {
  const src = tempDir(t);
  mkdirSync(join(src, "js"));
  writeFileSync(join(src, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "bgcheck", version: "1.0",
    background: { service_worker: "js/sw.js" },
    action: { default_popup: "js/popup.html" },
  }));
  writeFileSync(join(src, "js/sw.js"), 'importScripts("lib.js");\nvar SW = location.pathname === "/js/sw.js";\n');
  writeFileSync(join(src, "js/lib.js"), LIB);
  writeFileSync(join(src, "js/popup.html"), '<!doctype html><script src="lib.js"></script>');
  const out = tempDir(t);
  const res = runCli([src, "-o", out, "--no-launch", "--clean"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr + res.stdout);
  return join(out, "staged_extension");
}

// Run the staged background scripts, or the popup's, in a context shaped like it.
function run(staged, scripts, href, globals) {
  const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf-8"));
  const ctx = runInContext("", { browser: fakeBrowser({ manifest }), href, globals: { M: manifest, ...globals } });
  for (const s of scripts) vm.runInContext(readFileSync(join(staged, s), "utf-8"), ctx, { filename: s });
  return ctx;
}

test("the background's chunks know they are the background", (t) => {
  const staged = convert(t);
  const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf-8"));
  const ctx = run(staged, manifest.background.scripts, EXT_ORIGIN + "/_generated_background_page.html", { document: {} });
  assert.deepEqual({ ...ctx.R }, { hola: true, adblock: true, kind: "background" });
  assert.equal(ctx.SW, true, "the worker's own script too");
});

test("the popup, which loads the same chunk, still knows it isn't", (t) => {
  const staged = convert(t);
  const shim = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf-8")).background.scripts[0];
  const ctx = run(staged, [shim, "js/lib.js"], EXT_ORIGIN + "/js/popup.html", { document: {} });
  assert.deepEqual({ ...ctx.R }, { hola: false, adblock: false, kind: "page" });
});
