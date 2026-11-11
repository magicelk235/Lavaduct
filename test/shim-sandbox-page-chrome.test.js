import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// A manifest sandbox page gets no extension API in either browser, but Chrome
// still defines window.chrome there, as on every page (an object with no
// extension namespaces). Firefox defines no chrome at all, so code written for
// Chrome that reads it unguarded throws: Zotero's sandbox page runs
// webextension-polyfill, whose wrapAPIs() reads `chrome` and threw
// "ReferenceError: chrome is not defined".

test("a sandbox page without extension APIs gets an empty chrome object", () => {
  const ctx = runInContext(buildShim(), { href: EXT_ORIGIN + "/offscreen/sandbox.html" });
  assert.equal(typeof ctx.chrome, "object");
  assert.deepEqual(Object.keys(ctx.chrome), [], "nothing that looks like an extension API");
  assert.equal(ctx.browser, undefined, "no browser global either, as in Chrome");
});

test("only the add-on's own pages get it, and an existing chrome is left alone", () => {
  const web = runInContext(buildShim(), { href: "https://example.com/" });
  assert.equal(web.chrome, undefined);
  const own = { custom: true };
  const page = runInContext(buildShim(), { href: EXT_ORIGIN + "/sandbox.html", globals: { chrome: own } });
  assert.equal(page.chrome, own);
});
