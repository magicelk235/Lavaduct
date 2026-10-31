import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Firefox has no offscreen API, but its event page is a real document, so an
// offscreen document can live in a hidden iframe there: its scripts get the
// extension API and receive the background's runtime messages natively.

function fakeDocument() {
  const appended = [];
  const body = {
    appendChild(el) { appended.push(el); el.parentNode = body; return el; },
    removeChild(el) { appended.splice(appended.indexOf(el), 1); el.parentNode = null; return el; },
  };
  return {
    appended,
    body,
    createElement(tag) {
      const listeners = {};
      return {
        tagName: tag.toUpperCase(), style: {}, attrs: {}, parentNode: null,
        setAttribute(k, v) { this.attrs[k] = String(v); },
        addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
        removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
        fire(t) { for (const fn of listeners[t] || []) fn({ type: t }); },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      };
    },
  };
}

// The add-on's own code, as Chrome's offscreen documentation writes it.
const USES_OFFSCREEN = {
  "sw.js": 'if (!(await clients.matchAll()).length) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "x" });',
};

function background(globals = {}, files = USES_OFFSCREEN) {
  const browser = fakeBrowser();
  const document = fakeDocument();
  // The keep-alive interval would hold the test process open; tests that care pass their own.
  const timers = { setInterval: () => 0, clearInterval: () => {} };
  const ctx = runInContext(buildShim({}, files), { browser, globals: { document, ...timers, ...globals } });
  return { browser, document, ctx };
}

test("createDocument loads the page in a hidden iframe and resolves once it has loaded", async () => {
  const { browser, document } = background();
  let resolved = false;
  const p = browser.offscreen.createDocument({ url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "copy" })
    .then(() => { resolved = true; });
  assert.equal(document.appended.length, 1);
  const frame = document.appended[0];
  assert.equal(frame.tagName, "IFRAME");
  assert.equal(frame.src, EXT_ORIGIN + "/offscreen.html");
  await tick();
  assert.equal(resolved, false, "Chrome resolves only after the document's initial load");
  frame.fire("load");
  await p;
  assert.equal(await browser.offscreen.hasDocument(), true);
});

test("only one offscreen document at a time, and closing removes it", async () => {
  const { browser, document } = background();
  const p = browser.offscreen.createDocument({ url: "/off/doc.html", reasons: ["DOM_PARSER"], justification: "x" });
  document.appended[0].fire("load");
  await p;
  await assert.rejects(browser.offscreen.createDocument({ url: "other.html", reasons: ["DOM_PARSER"], justification: "x" }), /single offscreen document/);
  await browser.offscreen.closeDocument();
  assert.equal(document.appended.length, 0);
  assert.equal(await browser.offscreen.hasDocument(), false);
  await assert.rejects(browser.offscreen.closeDocument(), /No current offscreen document/);
});

test("callback style resolves too", async () => {
  const { browser, document } = background();
  const done = new Promise((resolve) => browser.offscreen.createDocument({ url: "o.html", reasons: ["BLOBS"], justification: "x" }, resolve));
  document.appended[0].fire("load");
  await done;
  assert.equal(await new Promise((r) => browser.offscreen.hasDocument(r)), true);
});

test("clients.matchAll() in a background that was a service worker reports the offscreen document", async () => {
  const browser = fakeBrowser();
  const document = fakeDocument();
  const views = [];
  browser.extension.getViews = () => views;
  const ctx = runInContext(buildShim({ serviceWorker: true, serviceWorkerScript: "sw.js" }, USES_OFFSCREEN), {
    browser,
    globals: { document, setInterval: () => 0, clearInterval: () => {} },
  });
  assert.deepEqual(plain(await ctx.clients.matchAll()), []);
  const p = browser.offscreen.createDocument({ url: "offscreen.html", reasons: ["AUDIO_PLAYBACK"], justification: "x" });
  document.appended[0].fire("load");
  await p;
  // Firefox lists the iframe among the add-on's views.
  const backgroundWindow = vm.runInContext("globalThis", ctx);
  const frameWindow = { location: { href: EXT_ORIGIN + "/offscreen.html" }, top: backgroundWindow };
  views.push(backgroundWindow, frameWindow);
  const found = await ctx.clients.matchAll();
  assert.deepEqual(plain(found.map((c) => c.url)), [EXT_ORIGIN + "/offscreen.html"]);
  assert.equal(found[0].visibilityState, "hidden", "a frame of the event page is never on screen");
});

test("while a document is open the event page is kept from going idle", async () => {
  const intervals = [];
  const { browser, document } = background({
    setInterval: (fn, ms) => { intervals.push({ fn, ms, live: true }); return intervals.length; },
    clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].live = false; },
  });
  const p = browser.offscreen.createDocument({ url: "offscreen.html", reasons: ["AUDIO_PLAYBACK"], justification: "x" });
  document.appended[0].fire("load");
  await p;
  const live = intervals.filter((i) => i.live);
  assert.equal(live.length, 1);
  assert.ok(live[0].ms < 30000, "Firefox suspends an idle event page after 30 s");
  live[0].fn();
  assert.ok(browser.calls.some((c) => c[0] === "runtime.getPlatformInfo"), "an extension API call resets the idle timer");
  await browser.offscreen.closeDocument();
  assert.equal(intervals.filter((i) => i.live).length, 0);
});

test("offscreen exists only in the background page", () => {
  for (const href of [EXT_ORIGIN + "/popup.html", "https://example.com/"]) {
    const browser = fakeBrowser();
    runInContext(buildShim({}, USES_OFFSCREEN), { browser, href, globals: { document: fakeDocument() } });
    assert.equal(browser.offscreen, undefined, href);
  }
});

test("an add-on that never uses offscreen gets no offscreen and no clients global", () => {
  const { browser, ctx } = background({}, { "sw.js": "chrome.runtime.onMessage.addListener(() => {});" });
  assert.equal(browser.offscreen, undefined);
  assert.equal(ctx.clients, undefined, "a clients global makes code think it runs in a service worker");
});
