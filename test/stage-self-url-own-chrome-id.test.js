import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { applySourceRewrites } from "../dist/input/stage.js";

// Compose AI keeps its own Chrome ID in a constant and builds its images as
// `chrome-extension://${w}/assets/${name}`: in Firefox the scheme doesn't exist and the
// host is no install's, so its popup logo never loaded. A Chrome-ID URL is also what a
// registered OAuth redirect_uri looks like (Claude in Chrome's
// `chrome-extension://${h}/oauth_callback.html`), which must stay as written. The
// discriminator: the URL names a file (or, with a computed rest, a directory) the add-on
// ships; a redirect_uri's page is never in the package.

const MANIFEST = { manifest_version: 3, name: "T", version: "1" };
const CID = "ddlbpiadoechcolndfeaonajmngmhblj";
const UUID = "0d5c3a8e-3f1b-4c55-9d7e-2b8e6f1a9c40";
const runtime = { id: `${CID}.46ff2962@lavaduct`, getURL: (p) => `moz-extension://${UUID}/${String(p).replace(/^\//, "")}` };
const PACKAGE = { "assets/logo.png": "png", "options.html": "<!doctype html>" };

function rewrite(t, code, chromeId = CID, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stage-own-id-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries({ ...PACKAGE, ...extra, "bg.js": code })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  applySourceRewrites(dir, MANIFEST, chromeId);
  return readFileSync(join(dir, "bg.js"), "utf-8");
}

// JSON round trip: arrays from the vm's realm don't deepEqual this realm's.
const run = (code) => JSON.parse(JSON.stringify(vm.runInContext(code, vm.createContext({ URL, chrome: { runtime }, browser: { runtime } }))));

test("a URL built from the own Chrome ID that names a packaged file resolves to the add-on", (t) => {
  const out = rewrite(t, `var w="${CID}",h=A=>\`chrome-extension://\${w}/assets/\${A}\`,N=\`chrome-extension://\${w}/assets/logo.png\`; [h("logo.png"), N]`);
  assert.deepEqual(run(out), [`moz-extension://${UUID}/assets/logo.png`, `moz-extension://${UUID}/assets/logo.png`]);
  new vm.Script(out);
});

test("a string literal that is a packaged own-ID URL resolves; others stay as written", (t) => {
  const src = [
    `var c={OPTIONS:"chrome-extension://${CID}/options.html"};`,
    `var t=\`chrome-extension://${CID}/assets/\${"logo.png"}\`;`,
    `var html='<a href="chrome-extension://${CID}/options.html">o</a>';`,
    `var keyed={"chrome-extension://${CID}/options.html":1};`,
    `var origin="chrome-extension://${CID}";`,
    `var probe="chrome-extension://${CID}/icon.png";`,
    `var other="chrome-extension://dahenjhkoodjbpjheillcadbppiidmhp/options.html";`,
    `[c.OPTIONS, t, html, Object.keys(keyed)[0], origin, probe, other]`,
  ].join("\n");
  const out = rewrite(t, src);
  assert.deepEqual(run(out), [
    `moz-extension://${UUID}/options.html`,
    `moz-extension://${UUID}/assets/logo.png`,
    `<a href="chrome-extension://${CID}/options.html">o</a>`,
    `chrome-extension://${CID}/options.html`,
    `chrome-extension://${CID}`,
    `chrome-extension://${CID}/icon.png`,
    "chrome-extension://dahenjhkoodjbpjheillcadbppiidmhp/options.html",
  ]);
});

test("an own-ID redirect_uri whose page isn't packaged stays as written", (t) => {
  const out = rewrite(t, `var h="${CID}",p={REDIRECT_URI:\`chrome-extension://\${h}/oauth_callback.html\`},q=\`chrome-extension://\${h}/\${"x"}\`; [p.REDIRECT_URI, q]`);
  assert.deepEqual(run(out), [`chrome-extension://${CID}/oauth_callback.html`, `chrome-extension://${CID}/x`]);
});

test("the own Chrome ID is accepted only when it is known and the code already holds it", (t) => {
  const compose = `var w="${CID}"; \`chrome-extension://\${w}/assets/logo.png\``;
  assert.equal(run(rewrite(t, compose, "")), `chrome-extension://${CID}/assets/logo.png`, "no Chrome ID known");
  const loom = rewrite(t, "`url(chrome-extension://${chrome.runtime.id}/assets/logo.png)`");
  assert.equal(run(loom), `url(moz-extension://${UUID}/assets/logo.png)`);
  assert.ok(!loom.includes(CID), "a bundle that never names its Chrome ID doesn't get it written in");
});
