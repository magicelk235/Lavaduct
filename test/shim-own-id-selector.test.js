import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// Chrome code puts chrome.runtime.id in selectors unquoted, which a Chrome ID
// (32 letters) survives and Firefox's gecko ID doesn't: its `.` and `@` throw a
// SyntaxError. The live behavior is in firefox-own-id-selector.test.js; this
// covers what the retry rewrites and what it leaves alone. fakeBrowser's
// runtime.id is "addon@example.test".

const BUNDLE = { "boot.js": 'document.querySelector("[data-extension-id=" + chrome.runtime.id + "]")' };

// Selector methods that refuse an unescaped, unquoted `@` the way a CSS parser
// does, and record each selector they were called with.
function fakeDom() {
  const seen = [];
  const native = (name) => function (selectors) {
    seen.push(selectors);
    if (selectors === "boom") throw new TypeError("not a selector problem");
    if (/(?:=\s*|#|\.)[^"'\]\s]*@/.test(selectors.replace(/\\./g, ""))) {
      const e = new Error(`'${selectors}' is not a valid selector`);
      e.name = "SyntaxError";
      throw e;
    }
    return name + ":" + selectors;
  };
  const window = {};
  for (const [ctor, names] of [
    ["Document", ["querySelector", "querySelectorAll"]],
    ["DocumentFragment", ["querySelector", "querySelectorAll"]],
    ["Element", ["querySelector", "querySelectorAll", "matches", "closest", "webkitMatchesSelector"]],
  ]) {
    const C = function () {};
    for (const n of names) C.prototype[n] = native(n);
    window[ctor] = C;
  }
  return { window, seen };
}

function contentScript(files = BUNDLE) {
  const dom = fakeDom();
  runInContext(buildShim({}, files), { browser: fakeBrowser(), href: "https://example.com/page", globals: { window: dom.window } });
  const doc = Object.create(dom.window.Document.prototype);
  const el = Object.create(dom.window.Element.prototype);
  return { ...dom, doc, el };
}

test("a selector holding runtime.id unquoted is retried with the ID quoted or escaped", () => {
  const { doc, el, seen } = contentScript();
  assert.equal(doc.querySelector("script.cfg[data-extension-id=addon@example.test]"), 'querySelector:script.cfg[data-extension-id="addon@example.test"]');
  assert.equal(el.matches("[data-id^= addon@example.test i]"), 'matches:[data-id^= "addon@example.test" i]');
  assert.equal(el.closest("div#addon@example.test > p"), "closest:div#addon\\@example\\.test > p");
  assert.equal(doc.querySelectorAll(".addon@example.test, [x=addon@example.test]"), 'querySelectorAll:.addon\\@example\\.test, [x="addon@example.test"]');
  assert.equal(seen.length, 8, "each one ran once as written, then once rewritten");
});

test("selectors that parse, and errors the ID didn't cause, are left alone", () => {
  const { doc, el, seen } = contentScript();
  assert.equal(doc.querySelector('[data-extension-id="addon@example.test"]'), 'querySelector:[data-extension-id="addon@example.test"]');
  assert.throws(() => doc.querySelector("[x=other@example.test]"), (e) => e.name === "SyntaxError" && e.message.includes("[x=other@example.test]"));
  assert.throws(() => el.matches("[x=addon@example.testing]"), (e) => e.name === "SyntaxError");
  assert.throws(() => el.matches("boom"), TypeError);
  assert.deepEqual(seen, ['[data-extension-id="addon@example.test"]', "[x=other@example.test]", "[x=addon@example.testing]", "boom"]);
});

test("a bundle that never reads runtime.id keeps the native selector methods", () => {
  const dom = fakeDom();
  const before = dom.window.Element.prototype.matches;
  runInContext(buildShim({}, { "c.js": 'document.querySelector("p")' }), { browser: fakeBrowser(), href: "https://example.com/page", globals: { window: dom.window } });
  assert.equal(dom.window.Element.prototype.matches, before);
});
