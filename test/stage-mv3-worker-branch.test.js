import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, tempDir } from "./cli-helpers.js";

// @webext-core/proxy-service (WXT add-ons) decides "am I the background?" with
// `manifest_version === 3 ? isBackgroundServiceWorker() : isBackgroundPage()`,
// and the worker test is `typeof window === "undefined"`. Firefox's event page
// has a window, so the background took itself for a client and proxied every
// call to its own services over runtime.sendMessage, which never reaches the
// sender: StayFocusd's timers failed every second with "Receiving end does not
// exist". The detector sits in a chunk the module worker imports, which the
// add-on's pages import too, so there it must keep answering no.

const CHUNK = [
  'var G={runtime:{id:"x",getManifest:()=>({manifest_version:3,background:{}})}};',
  "function XE(){if(!QE())return!1;const e=G.runtime.getManifest();return e.background?e.manifest_version===3?nD():tD():!1}",
  "function QE(){return!!G.runtime?.id}",
  'var eD=["/_generated_background_page.html"];function tD(){return typeof window<"u"&&eD.includes(location.pathname)}',
  'function nD(){return typeof window>"u"}',
  'const inline=G.runtime.getManifest().manifest_version===3?typeof window>"u":!1;',
  'function isNode(){return typeof window>"u"}',
  "export { XE as isBackground, inline, isNode };",
].join("\n");

// Evaluate the chunk where window exists, as the event page or a page.
function answers(src, { background }) {
  const body = src.replace(/export \{[^}]*\};/, "return { isBackground: XE(), inline, isNode: isNode() };");
  const g = { __lavaductBackground: background ? true : undefined };
  return new Function("window", "location", "globalThis", body)({}, { pathname: "/popup.html" }, g);
}

test("an MV3 branch's worker test in a module worker's imported chunk says yes in the background only", (t) => {
  const src = tempDir(t);
  mkdirSync(join(src, "chunks"));
  writeFileSync(join(src, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "m", version: "1.0", background: { service_worker: "background.js", type: "module" }, action: { default_popup: "popup.html" } }));
  writeFileSync(join(src, "background.js"), 'import { isBackground } from "./chunks/proxy.js";\nconsole.log(isBackground());\n');
  writeFileSync(join(src, "chunks/proxy.js"), CHUNK);
  writeFileSync(join(src, "popup.html"), '<script type="module" src="popup.js"></script>');
  writeFileSync(join(src, "popup.js"), 'import { isBackground } from "./chunks/proxy.js";\n');
  assert.deepEqual(answers(CHUNK, { background: true }), { isBackground: false, inline: false, isNode: false }, "unrewritten, the event page says no");

  const out = tempDir(t);
  const res = runCli([src, "-o", out, "--no-launch", "--clean"], { state: tempDir(t) });
  assert.equal(res.code, 0, res.stderr + res.stdout);
  const staged = readFileSync(join(out, "staged_extension", "chunks/proxy.js"), "utf-8");
  assert.deepEqual(answers(staged, { background: true }), { isBackground: true, inline: true, isNode: false }, staged);
  assert.deepEqual(answers(staged, { background: false }), { isBackground: false, inline: false, isNode: false }, "a page that imports the chunk still says no");
  assert.match(staged, /function isNode\(\)\{return typeof window>"u"\}/, "a window test no MV3 branch picks is left alone");
});
