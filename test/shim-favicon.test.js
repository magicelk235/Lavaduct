import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, runInContext, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Chrome serves favicons at chrome://favicon/<url> (MV2) and
// chrome-extension://<id>/_favicon/?pageUrl=<url> (MV3). Firefox has neither:
// the first is blocked and the second is a missing file. The shim answers both
// for fetch() and <img> in extension pages, from the open tab's icon when there
// is one.

const USES_FAVICONS = { "popup.js": 'img.src = "chrome://favicon/" + url;' };
const RED_DOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function page({ tabs = [], files = USES_FAVICONS, globals = {}, href = EXT_ORIGIN + "/popup.html" } = {}) {
  const browser = fakeBrowser();
  // Content scripts have no tabs API.
  if (href.startsWith(EXT_ORIGIN)) browser.tabs = { query: async () => tabs };
  else delete browser.tabs;
  const nativeCalls = [];
  // Data URLs load for real; network requests fail, as a cross-origin favicon
  // fetch without host permission would.
  const nativeFetch = (input, init) => {
    nativeCalls.push([input, init]);
    if (String(input).startsWith("data:")) return fetch(input);
    return Promise.reject(new TypeError("NetworkError when attempting to fetch resource."));
  };
  const ctx = runInContext(buildShim({}, files), { browser, href, globals: { fetch: nativeFetch, ...globals } });
  return { ctx, browser, nativeFetch, nativeCalls };
}

const bytes = async (res) => [...new Uint8Array(await res.arrayBuffer())];

test("fetch(chrome://favicon/<url>) returns the open tab's icon", async () => {
  const { ctx } = page({ tabs: [{ id: 1, url: "https://example.com/page", favIconUrl: RED_DOT }] });
  const res = await ctx.fetch("chrome://favicon/size/16@2x/https://example.com/page");
  assert.equal(res.ok, true);
  assert.deepEqual(await bytes(res), await bytes(await fetch(RED_DOT)));
});

test("fetch of a _favicon URL with no icon available still returns an image", async () => {
  const { ctx } = page();
  const res = await ctx.fetch(EXT_ORIGIN + "/_favicon/?pageUrl=" + encodeURIComponent("https://nowhere.example/") + "&size=32");
  assert.equal(res.ok, true);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual((await bytes(res)).slice(0, 4), PNG_SIGNATURE);
});

test("other requests go to the native fetch untouched", async () => {
  const { ctx, nativeCalls } = page();
  const init = { method: "POST" };
  await assert.rejects(ctx.fetch("https://api.example.com/v1", init));
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0][0], "https://api.example.com/v1");
  assert.equal(nativeCalls[0][1], init);
});

function fakeImg(src) {
  const listeners = {};
  const img = {
    nodeType: 1, tagName: "IMG", _src: src,
    getAttribute(n) { return n === "src" ? img._src : null; },
    get src() { return img._src; },
    set src(v) { img._src = String(v); },
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    fire(t) { for (const fn of [...(listeners[t] || [])]) fn({ type: t, target: img }); },
    getElementsByTagName: () => [],
  };
  return img;
}

function fakeDocument() {
  const capture = [];
  return {
    capture,
    documentElement: { nodeType: 1 },
    addEventListener(type, fn, opts) { if (type === "error" && (opts === true || (opts && opts.capture))) capture.push(fn); },
  };
}

// new Image() that loads data: URLs and the given reachable URLs, and fails on anything else.
function imageLoading(reachable = []) {
  return class Image {
    set src(url) {
      const ok = String(url).startsWith("data:") || reachable.includes(String(url));
      setTimeout(() => (ok ? this.onload : this.onerror)?.(), 0);
    }
  };
}

const isGlobe = (src) => /^data:image\/png;base64,iVBOR/.test(src) && src !== RED_DOT;

test("a favicon <img> that failed to load shows the open tab's icon", async () => {
  const document = fakeDocument();
  page({ tabs: [{ id: 1, url: "https://example.com/a", favIconUrl: RED_DOT }], globals: { document, Image: imageLoading() } });
  const img = fakeImg("chrome://favicon/https://example.com/a");
  for (const fn of document.capture) fn({ type: "error", target: img });
  assert.ok(isGlobe(img.src), "a generic icon right away");
  await tick(5);
  assert.equal(img.src, RED_DOT);
});

test("a late error from the original favicon URL doesn't undo the fix", async () => {
  const document = fakeDocument();
  page({ globals: { document, Image: imageLoading(["https://example.org/favicon.ico"]) } });
  const img = fakeImg("/_favicon/?pageUrl=" + encodeURIComponent("https://example.org/x"));
  for (const fn of document.capture) fn({ type: "error", target: img });
  // Firefox can deliver the error for the old src after it was replaced.
  img.fire("error");
  for (const fn of document.capture) fn({ type: "error", target: img });
  await tick(5);
  assert.equal(img.src, "https://example.org/favicon.ico");
});

test("with no icon reachable the <img> keeps the generic icon", async () => {
  const document = fakeDocument();
  page({ globals: { document, Image: imageLoading() } });
  const img = fakeImg("chrome://favicon/https://down.example/");
  for (const fn of document.capture) fn({ type: "error", target: img });
  await tick(5);
  assert.ok(isGlobe(img.src));
});

test("favicon <img> elements added to an extension page are fixed before they load", async () => {
  const observers = [];
  class MutationObserver { constructor(cb) { observers.push(cb); } observe() {} }
  page({ globals: { document: fakeDocument(), MutationObserver, Image: imageLoading(["https://example.net/favicon.ico"]) } });
  assert.equal(observers.length, 1);
  const img = fakeImg(EXT_ORIGIN + "/_favicon/?pageUrl=https%3A%2F%2Fexample.net%2F");
  observers[0]([{ type: "childList", addedNodes: [img] }]);
  assert.ok(isGlobe(img.src));
  await tick(5);
  assert.equal(img.src, "https://example.net/favicon.ico");
});

test("a favicon <img> a content script put into a web page is fixed when it fails to load", async () => {
  const observers = [];
  class MutationObserver { constructor(cb) { observers.push(cb); } observe() {} }
  const document = fakeDocument();
  page({ href: "https://news.example/", globals: { document, MutationObserver, Image: imageLoading(["https://example.org/favicon.ico"]) } });
  assert.equal(observers.length, 0, "web pages aren't observed");
  const img = fakeImg(EXT_ORIGIN + "/_favicon/?pageUrl=" + encodeURIComponent("https://example.org/") + "&size=16");
  for (const fn of document.capture) fn({ type: "error", target: img });
  await tick(5);
  assert.equal(img.src, "https://example.org/favicon.ico");
  const pagesOwn = fakeImg("/_favicon/?pageUrl=x");
  for (const fn of document.capture) fn({ type: "error", target: pagesOwn });
  assert.equal(pagesOwn.src, "/_favicon/?pageUrl=x", "a relative URL there is the web page's own");
});

test("an extension that never uses favicon URLs keeps the native fetch", () => {
  const { ctx, nativeFetch } = page({ files: { "popup.js": "fetch('/data.json')" } });
  assert.equal(ctx.fetch, nativeFetch);
});
