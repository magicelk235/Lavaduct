import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, tempDir } from "./cli-helpers.js";
import { EXT_ORIGIN, fakeBrowser, runInContext } from "./shim-sandbox.js";

// The worker test inside an is…Background() body sits behind blocks of its own
// as often as not. Total Adblock's vendor chunk, which its worker imports and its
// popup loads too:
//   static isBackgroundScript() {
//     if (this.isMv2()) { const e = document.querySelectorAll("script");
//       for (let t in e) if (e.hasOwnProperty(t)) { if (e[t].src.includes("…")) return !0 }
//       return !1 }
//     return "undefined" == typeof document }
// In the event page that says no, so its Redux.subscribe() takes the page path and
// throws "store has not been created" in the background. A brace inside a string
// must not end the body early.

const LIB = `var R = {
  nested: (function () { class C { static isMv2() { return 2 === M.manifest_version; } static isBackgroundScript() { if (this.isMv2()) { const e = document.querySelectorAll("script"); for (let t in e) if (e.hasOwnProperty(t)) { if (e[t].src.includes("bg.js")) return !0 } return !1 } return "undefined" == typeof document } } return C.isBackgroundScript(); })(),
  braceString: (function () { var o = { isServiceWorker: function () { if (typeof location === "}") { return false; } var s = '{'; return typeof window === "undefined"; } }; return o.isServiceWorker(); })(),
  unrelated: (function () { function hasDom() { if (M) { return typeof document !== "undefined"; } return false; } return hasDom(); })(),
};
`;

function convert(t) {
  const src = tempDir(t);
  mkdirSync(join(src, "js"));
  writeFileSync(join(src, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "bgnested", version: "1.0",
    background: { service_worker: "js/sw.js" },
    action: { default_popup: "js/popup.html" },
  }));
  writeFileSync(join(src, "js/sw.js"), 'importScripts("lib.js");\n');
  writeFileSync(join(src, "js/lib.js"), LIB);
  writeFileSync(join(src, "js/popup.html"), '<!doctype html><script src="lib.js"></script>');
  const out = tempDir(t);
  const res = runCli([src, "-o", out, "--no-launch", "--clean"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr + res.stdout);
  return join(out, "staged_extension");
}

function run(staged, scripts, href) {
  const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf-8"));
  const document = { querySelectorAll: () => [] };
  const ctx = runInContext("", { browser: fakeBrowser({ manifest }), href, globals: { M: manifest, document } });
  for (const s of scripts) vm.runInContext(readFileSync(join(staged, s), "utf-8"), ctx, { filename: s });
  return ctx;
}

test("an is…Background() body with nested blocks says yes in the background", (t) => {
  const staged = convert(t);
  const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf-8"));
  const ctx = run(staged, manifest.background.scripts, EXT_ORIGIN + "/_generated_background_page.html");
  assert.deepEqual({ ...ctx.R }, { nested: true, braceString: true, unrelated: true });
});

test("the popup loading the same chunk still says no", (t) => {
  const staged = convert(t);
  const shim = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf-8")).background.scripts[0];
  const ctx = run(staged, [shim, "js/lib.js"], EXT_ORIGIN + "/js/popup.html");
  assert.deepEqual({ ...ctx.R }, { nested: false, braceString: false, unrelated: true });
});
