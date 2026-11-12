import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";

// Chrome structured-clones a CustomEvent's detail for a listener in another
// world, so an isolated content script hands its world: "MAIN" script plain
// objects (Enhancer for YouTube passes its preferences that way). In Firefox the
// page gets the content script's object and every read throws "Permission denied
// to access property". The shim gives the event a clone in the page's
// compartment (cloneInto) and keeps the original for the content script's own
// listeners. Here the page's view is the native detail getter, which is what a
// page-world listener runs; the content script's view is event.detail.

const USES_EVENTS = { "js/isolated.js": 'document.dispatchEvent(new CustomEvent("x-init", { detail: { prefs } }));' };

// The page's CustomEvent as a content script reaches it, through window.
function pageWindow() {
  class Event {
    constructor(type, init = {}) {
      if (arguments.length === 0) throw new TypeError("Event constructor: At least 1 argument required, but only 0 passed");
      this.type = String(type);
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.composed = !!init.composed;
    }
  }
  class CustomEvent extends Event {
    #detail;
    constructor(type, init = {}) {
      super(...arguments);
      this.#detail = init && "detail" in init ? init.detail : null;
    }
    get detail() { return this.#detail; }
    initCustomEvent(type, bubbles, cancelable, detail) {
      this.type = String(type);
      this.bubbles = !!bubbles;
      this.cancelable = !!cancelable;
      this.#detail = detail;
    }
  }
  return { CustomEvent, Event };
}

function contentScript({ files = USES_EVENTS, href = "https://www.youtube.com/watch?v=1" } = {}) {
  const win = pageWindow();
  const nativeDetail = Object.getOwnPropertyDescriptor(win.CustomEvent.prototype, "detail").get;
  const cloned = new WeakSet();
  // Firefox's cloneInto: a structured clone into the target's compartment, which
  // refuses functions.
  const cloneInto = (value, target) => {
    assert.equal(target, win);
    const copy = structuredClone(value);
    cloned.add(copy);
    return copy;
  };
  const sandbox = runInContext(buildShim({}, files), { browser: fakeBrowser(), href, globals: { window: win, cloneInto } });
  return { sandbox, win, cloned, pageView: (event) => nativeDetail.call(event) };
}

test("the page reads a clone of a content script's CustomEvent detail; the content script keeps its object", () => {
  const { sandbox, win, cloned, pageView } = contentScript();
  const prefs = { controlbar: { active: true }, speed: 1.25, list: [1, 2, 3] };
  const event = new sandbox.CustomEvent("efyt-init", { detail: { prefs }, bubbles: true, cancelable: true });

  const forPage = pageView(event);
  assert.ok(cloned.has(forPage), "the page's detail is a clone in its compartment");
  assert.deepEqual(plain(forPage), { prefs: { controlbar: { active: true }, speed: 1.25, list: [1, 2, 3] } });
  assert.equal(event.detail.prefs, prefs, "the content script's listeners see the object it passed");
  assert.equal(event.type, "efyt-init");
  assert.equal(event.bubbles, true);
  assert.equal(event.cancelable, true);

  assert.equal(win.CustomEvent, sandbox.CustomEvent, "window.CustomEvent is the same constructor");
  assert.ok(event instanceof sandbox.CustomEvent);
  assert.ok(event instanceof win.Event);
  assert.equal(event.constructor, sandbox.CustomEvent);
  assert.equal(sandbox.CustomEvent.name, "CustomEvent");
});

test("initCustomEvent clones the detail for the page too", () => {
  const { sandbox, cloned, pageView } = contentScript();
  const event = new sandbox.CustomEvent("legacy");
  const detail = { a: { b: 1 } };
  event.initCustomEvent("legacy", true, false, detail);
  assert.ok(cloned.has(pageView(event)));
  assert.deepEqual(plain(pageView(event)), { a: { b: 1 } });
  assert.equal(event.detail, detail);
  event.initCustomEvent("legacy", true, false, "text");
  assert.equal(pageView(event), "text");
  assert.equal(event.detail, "text");
});

test("details cloneInto refuses, primitives and missing details reach the page as before", () => {
  const { sandbox, cloned, pageView } = contentScript();
  const withFunction = { run() {} };
  const fn = new sandbox.CustomEvent("f", { detail: withFunction });
  assert.equal(pageView(fn), withFunction);
  assert.equal(fn.detail, withFunction);
  assert.equal(pageView(new sandbox.CustomEvent("s", { detail: "json" })), "json");
  assert.equal(pageView(new sandbox.CustomEvent("n", { detail: null })), null);
  assert.equal(pageView(new sandbox.CustomEvent("none")), null);
  assert.equal(pageView(new sandbox.CustomEvent("empty", {})), null);
  assert.equal(new sandbox.CustomEvent("none").detail, null);
  assert.equal(cloned.has(pageView(new sandbox.CustomEvent("none"))), false);
  assert.throws(() => sandbox.CustomEvent("no-new"), TypeError);
  assert.throws(() => new sandbox.CustomEvent(), TypeError);
});

test("the constructor is left alone for add-ons that make no CustomEvent, and in extension pages", () => {
  const unused = contentScript({ files: { "js/isolated.js": 'document.addEventListener("x", () => {});' } });
  assert.equal(Object.hasOwn(unused.sandbox, "CustomEvent"), false);
  assert.match(String(unused.win.CustomEvent), /^class CustomEvent/);
  assert.equal(unused.pageView(new unused.win.CustomEvent("x", { detail: 1 })), 1);

  const page = contentScript({ href: EXT_ORIGIN + "/popup.html" });
  assert.equal(Object.hasOwn(page.sandbox, "CustomEvent"), false);
  const event = new page.win.CustomEvent("x", { detail: { a: 1 } });
  assert.equal(page.cloned.has(page.pageView(event)), false);
});
