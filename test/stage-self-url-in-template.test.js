import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { applySourceRewrites } from "../dist/input/stage.js";

// Loom styles its in-page UI with
//   `@font-face{src:url('chrome-extension://${chrome.runtime.id}/fonts/…')}`
// and frames `chrome-extension://${em6}/html/permissionsCheck.html` with
// `em6 = chrome.runtime.id`; Monica builds its images as
// `chrome-extension://${this.envvars?.extensionId}/static/${e}`. None of these is a
// template that IS the whole URL, so they stayed as written, and Firefox refused every
// font, image and frame ("unknown protocol"). The same shape names another extension's
// page when a bundle probes for one, and a Chrome-ID literal can be a registered OAuth
// redirect_uri, so only a host that is the add-on's own ID may change.

const MANIFEST = { manifest_version: 3, name: "T", version: "1" };
const GECKO_ID = "liecbddmkiiihnedobmlmillhodjkdmb.46ff2962@lavaduct";
const UUID = "0d5c3a8e-3f1b-4c55-9d7e-2b8e6f1a9c40";
const runtime = { id: GECKO_ID, getURL: (p) => `moz-extension://${UUID}/${String(p).replace(/^\//, "")}` };

function rewrite(t, src) {
  const dir = mkdtempSync(join(tmpdir(), "stage-self-url-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "content.js"), src);
  applySourceRewrites(dir, MANIFEST);
  return { dir, out: readFileSync(join(dir, "content.js"), "utf-8") };
}

/** Run rewritten code where `globalThis` carries `ns` (chrome/browser or nothing). */
function run(code, ns = { chrome: { runtime }, browser: { runtime } }) {
  const ctx = vm.createContext({ URL, ...ns });
  return vm.runInContext(code, ctx);
}

test("a self URL inside a larger template resolves to the add-on's moz-extension origin", (t) => {
  const { out } = rewrite(t, "var css = `@font-face{font-family:A;src:url('chrome-extension://${chrome.runtime.id}/fonts/a.woff2') format('woff2')}`; css");
  assert.equal(run(out), `@font-face{font-family:A;src:url('moz-extension://${UUID}/fonts/a.woff2') format('woff2')}`);
  const img = rewrite(t, 'var html = `<p><img src="chrome-extension://${window.chrome.runtime.id}/img/x.png"></p>`; html').out;
  assert.equal(run(img, { window: { chrome: { runtime } }, chrome: { runtime } }), `<p><img src="moz-extension://${UUID}/img/x.png"></p>`);
});

test("a host that aliases runtime.id, or a field holding it, resolves too", (t) => {
  const alias = rewrite(t, "let em6=chrome.runtime.id,em5=`chrome-extension://${em6}/html/permissionsCheck.html`; em5").out;
  assert.equal(run(alias), `moz-extension://${UUID}/html/permissionsCheck.html`);
  const field = rewrite(
    t,
    "var V = { envvars: { extensionId: chrome.runtime.id }, get(e) { return `chrome-extension://${this.envvars?.extensionId}/static/${e}`; } }; V.get('logo.png')",
  ).out;
  assert.equal(run(field), `moz-extension://${UUID}/static/logo.png`);
  const host = rewrite(t, "var u = `x chrome-extension://${new URL(chrome.runtime.getURL('/')).host}/a`; u").out;
  assert.equal(run(host), `x moz-extension://${UUID}/a`, "the add-on's own UUID host gets the right scheme");
});

test("another extension's ID and a Chrome-ID redirect_uri stay as written", (t) => {
  const other = rewrite(t, "var ids = { reader: 'dahenjhkoodjbpjheillcadbppiidmhp' }; `<iframe src=\"chrome-extension://${ids.reader}/reader.html\">`").out;
  assert.equal(run(other), '<iframe src="chrome-extension://dahenjhkoodjbpjheillcadbppiidmhp/reader.html">');
  const redirect = rewrite(t, 'var c = { REDIRECT_URI: `chrome-extension://${"fcoeoabgfenejglbffodgkkbkcdhcgfn"}/oauth_callback.html` }; c.REDIRECT_URI').out;
  assert.equal(run(redirect), "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html");
  assert.equal(run(rewrite(t, "`chrome-extension://${undefined}/x`").out), "chrome-extension://undefined/x");
});

test("without an extension API the URL comes back as written", (t) => {
  const { out } = rewrite(t, "var id = 'abc'; `url(chrome-extension://${id}/f.woff2)`");
  assert.equal(run(out, {}), "url(chrome-extension://abc/f.woff2)");
});

test("the host expression is evaluated once, in place, and the template keeps its shape", (t) => {
  const { out } = rewrite(
    t,
    "var n = 0, tag = (s, ...v) => s.length + ':' + v.length + ':' + s.join('|') + v.join('|');" +
      "var a = `chrome-extension://${(n++, chrome.runtime.id)}/a ${`chrome-extension://${{ k: chrome.runtime.id }.k}/b`}`;" +
      "var b = tag`<i>chrome-extension://${chrome.runtime.id}/c</i>`; [a, b, n].join(' ')",
  );
  assert.equal(run(out), `moz-extension://${UUID}/a moz-extension://${UUID}/b 2:1:<i>|/c</i>moz-extension://${UUID} 1`);
  new vm.Script(out); // still parses
});

test("whole-URL and origin forms keep their plainer rewrites, and a second pass changes nothing", (t) => {
  const { dir, out } = rewrite(t, "chrome.tabs.create({ url: `chrome-extension://${chrome.runtime.id}/options.html` }); x = `chrome-extension://${chrome.runtime.id}`;");
  assert.equal(out, 'chrome.tabs.create({ url: chrome.runtime.getURL(`options.html`) }); x = new URL(chrome.runtime.getURL("/")).origin;');
  writeFileSync(join(dir, "content.js"), "`a chrome-extension://${chrome.runtime.id}/b`");
  applySourceRewrites(dir, MANIFEST);
  const once = readFileSync(join(dir, "content.js"), "utf-8");
  applySourceRewrites(dir, MANIFEST);
  assert.equal(readFileSync(join(dir, "content.js"), "utf-8"), once);
});
