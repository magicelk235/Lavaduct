import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// A Firefox content script's `window` and `self` are an Xray to the page's
// window, so `self.Reflect` is the page's Reflect, not the script's: in
// Firefox 160 `self.Object !== Object`, and defining a function on
// `self.Reflect` throws "Not allowed to define cross-origin object as property
// on [Object] or [Array] XrayWrapper". Chrome's isolated world has
// `window.Reflect === Reflect`. reflect-metadata (tsyringe, inversify) finds
// its global with `typeof self === "object" ? self : …` and defines its
// functions on root.Reflect, so Avast Online Security's whole content script
// died while it loaded. Measured in Firefox by
// test/firefox-content-window-builtins.test.js; here the page is a second vm
// realm.

// reflect-metadata's own shape: the global lookup, then a write onto root.Reflect.
const LOOKUP = `var root = typeof global === "object" ? global : typeof self === "object" ? self : globalThis;`;
const REFLECT_METADATA = `${LOOKUP} if (typeof root.Reflect === "undefined") { root.Reflect = Reflect3; }`;

function contentScript(code = REFLECT_METADATA) {
  const page = vm.runInNewContext("({ Object, Array, Reflect, Symbol, Promise, JSON, Map, Uint8Array, Function, fetch: function fetch() {} })");
  const windowXray = { ...page };
  windowXray.self = windowXray;
  const ctx = runInContext(buildShim({}, { "cs.js": code }), {
    browser: fakeBrowser(), href: "https://example.com/", globals: { window: windowXray },
  });
  // In Firefox `self` is the same Xray as `window`; the helper makes it the global.
  ctx.self = windowXray;
  return { ctx, page, windowXray };
}

test("a content script reaches its own built-ins through window and self, as in Chrome's isolated world", () => {
  const { ctx } = contentScript();
  const out = vm.runInContext(`[
    self.Reflect === Reflect, window.Object === Object, self.Array === Array, window.Symbol === Symbol,
    window.Promise === Promise, window.JSON === JSON, window.Map === Map,
  ]`, ctx);
  assert.deepEqual([...out], [true, true, true, true, true, true, true]);
});

test("window gives the script's own global under a built-in's name, as in Chrome", () => {
  const { ctx } = contentScript();
  vm.runInContext(`var Atomics = "mine"; window.Promise = "polyfill";`, ctx);
  assert.deepEqual([...vm.runInContext(`[window.Atomics, Promise]`, ctx)], ["mine", "polyfill"]);
});

test("reflect-metadata's global lookup defines its functions on the script's own Reflect", () => {
  const { ctx, page } = contentScript();
  vm.runInContext(`${LOOKUP} Object.defineProperty(root.Reflect, "metadata", { configurable: true, writable: true, value: function metadata() {} });`, ctx);
  assert.equal(vm.runInContext("typeof Reflect.metadata", ctx), "function");
  assert.equal(typeof page.Reflect.metadata, "undefined", "the page's Reflect is untouched");
});

test("only ECMAScript built-ins are aliased; Function and the window's web APIs stay the page's", () => {
  const { ctx, page } = contentScript();
  assert.equal(vm.runInContext("window.Function", ctx), page.Function, "Function keeps evaluating in the page, under its CSP");
  assert.equal(vm.runInContext("window.fetch", ctx), page.fetch);
});

test("extension pages, and bundles that never write onto a built-in through an alias, keep Firefox's window", () => {
  const none = contentScript(`${LOOKUP} console.log(root.document);`);
  assert.equal(none.windowXray.Reflect, none.page.Reflect);

  const page = vm.runInNewContext("({ Reflect })");
  const win = { Reflect: page.Reflect };
  runInContext(buildShim({}, { "p.js": REFLECT_METADATA }), { browser: fakeBrowser(), globals: { window: win } });
  assert.equal(win.Reflect, page.Reflect, "an extension page's window is left alone");
});

test("a Firefox-aware bundle keeps window's built-ins the page's, so it can still build page values with them", () => {
  // Code written for Firefox's Xrays makes values the page can read with
  // `new window.Object()` or `new window.Uint8Array()`, next to cloneInto.
  const firefoxAware = `${REFLECT_METADATA} const v = new window.Object(); v.x = 1; window.wrappedJSObject.data = cloneInto({ a: 1 }, window);`;
  const { windowXray, page } = contentScript(firefoxAware);
  assert.equal(windowXray.Object, page.Object);
  assert.equal(windowXray.Uint8Array, page.Uint8Array);
});
