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

const LOOKUP = `var root = typeof global === "object" ? global : typeof self === "object" ? self : globalThis;`;

function contentScript(code = LOOKUP) {
  const page = vm.runInNewContext("({ Object, Array, Reflect, Symbol, Promise, JSON, Map, Function, fetch: function fetch() {} })");
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

test("extension pages and bundles without a window global lookup keep Firefox's window", () => {
  const none = contentScript("console.log(1);");
  assert.equal(none.windowXray.Reflect, none.page.Reflect);

  const page = vm.runInNewContext("({ Reflect })");
  const win = { Reflect: page.Reflect };
  runInContext(buildShim({}, { "p.js": LOOKUP }), { browser: fakeBrowser(), globals: { window: win } });
  assert.equal(win.Reflect, page.Reflect, "an extension page's window is left alone");
});
