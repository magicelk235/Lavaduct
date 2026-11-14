import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, tempDir } from "./cli-helpers.js";
import { EXT_ORIGIN, fakeBrowser, runInContext } from "./shim-sandbox.js";

// A bundle can ask "am I the worker?" of any location-like value, not only of
// `location` itself. Magical's background:
//   function aB(e){return`${e.origin}/`===chrome.runtime.getURL("")}
//   function rB(e){return aB(e)&&e.pathname==="/background/background.js"}
//   if(!rB(globalThis.location))throw new Error("Loaded in an unexpected context");
// The event page's path is /_generated_background_page.html, so the check failed
// and the background stopped at its first line of real work. A path compared with
// the worker script's names Chrome's background, whose Firefox counterpart is the
// generated page, so the comparison accepts that path too. No page of the add-on
// has it, so the pages that load the same chunk keep their answer.

// Node gives a moz-extension: URL the origin "null", so the origin test reads href.
const CHECKS = `function aB(e){return e.href.startsWith(chrome.runtime.getURL(""))}
function rB(e){return aB(e)&&e.pathname==="/background/background.js"}
function notBg(u){return u.pathname!=="/background/background.js"}
`;

function convert(t) {
  const src = tempDir(t);
  mkdirSync(join(src, "background"));
  writeFileSync(join(src, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "pathparam", version: "1.0",
    background: { service_worker: "background/background.js" },
    action: { default_popup: "popup.html" },
  }));
  writeFileSync(join(src, "background/background.js"), 'importScripts("/checks.js");\n' + CHECKS +
    'if(!rB(globalThis.location))throw new Error("Loaded in an unexpected context");\n' +
    'var BG = { self: rB(globalThis.location), notBg: notBg(location), popup: rB(new URL(chrome.runtime.getURL("popup.html"))) };\n');
  writeFileSync(join(src, "checks.js"), CHECKS.replace(/\b(aB|rB|notBg)\b/g, "$1_") +
    "var R = { isBg: rB_(globalThis.location), notBg: notBg_(location) };\n");
  writeFileSync(join(src, "popup.html"), '<!doctype html><script src="checks.js"></script>');
  const out = tempDir(t);
  const res = runCli([src, "-o", out, "--no-launch", "--clean"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr + res.stdout);
  return join(out, "staged_extension");
}

function run(staged, scripts, href) {
  const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf-8"));
  const browser = fakeBrowser({ manifest });
  browser.runtime.getURL = (p) => EXT_ORIGIN + "/" + p.replace(/^\//, "");
  const ctx = runInContext("", { browser, href, globals: { URL } });
  for (const s of scripts) vm.runInContext(readFileSync(join(staged, s), "utf-8"), ctx, { filename: s });
  return ctx;
}

test("a worker-path check of a location passed as a parameter holds in the event page", (t) => {
  const staged = convert(t);
  const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf-8"));
  let ctx;
  assert.doesNotThrow(() => { ctx = run(staged, manifest.background.scripts, EXT_ORIGIN + "/_generated_background_page.html"); });
  assert.deepEqual({ ...ctx.BG }, { self: true, notBg: false, popup: false }, "the worker's own script");
  assert.deepEqual({ ...ctx.R }, { isBg: true, notBg: false }, "a chunk the worker loads");
});

test("the popup, which loads the same chunk, still isn't the worker", (t) => {
  const staged = convert(t);
  const shim = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf-8")).background.scripts[0];
  const ctx = run(staged, [shim, "checks.js"], EXT_ORIGIN + "/popup.html");
  assert.deepEqual({ ...ctx.R }, { isBg: false, notBg: true });
});
