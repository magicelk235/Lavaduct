import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Calls Chrome extensions make that Firefox refuses or never answers, found by
// loading converted Web Store extensions into Firefox.

test("dynamic rules Firefox would refuse are left out, and the rest reach Firefox adapted", async () => {
  const calls = [];
  const dnr = {
    updateDynamicRules: (options, cb) => { calls.push(options); if (cb) cb(); return Promise.resolve(); },
    updateSessionRules: (options) => { calls.push(options); return Promise.resolve(); },
  };
  const browser = fakeBrowser({ extra: { declarativeNetRequest: dnr } });
  const ctx = runInContext(buildShim(), { browser });
  const rule = (id, condition, action = { type: "block" }) => ({ id, priority: 1, action, condition: { urlFilter: "x", ...condition } });
  ctx.rules = [
    rule(1, { resourceTypes: ["script", "webtransport"] }),
    rule(2, { responseHeaders: [{ header: "content-type", values: ["text/html"] }] }),
    rule(3, { resourceTypes: ["webbundle"] }),
    rule(4, { domains: ["example.com"] }),
    rule(5, {}, { type: "redirect", redirect: { url: "data:text/javascript," } }),
    rule(6, { regexFilter: "(?i)ads" }),
    rule(7, {}),
  ];
  vm.runInContext("chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [9], addRules: rules }, () => { calledBack = true; })", ctx);
  await vm.runInContext("chrome.declarativeNetRequest.updateSessionRules({ addRules: [rules[1]] })", ctx);

  const sent = plain(calls[0]);
  assert.deepEqual(sent.removeRuleIds, [9]);
  assert.deepEqual(sent.addRules.map((r) => r.id), [1, 4, 7]);
  assert.deepEqual(sent.addRules[0].condition.resourceTypes, ["script"]);
  assert.deepEqual(sent.addRules[1].condition, { urlFilter: "x", initiatorDomains: ["example.com"] });
  assert.equal(ctx.calledBack, true, "the callback still runs");
  assert.deepEqual(plain(calls[1]).addRules, [], "a call whose only rule Firefox can't take still goes through");
  assert.equal(ctx.rules[0].condition.resourceTypes.length, 2, "the caller's rule objects are left alone");
});

test("runtime.getContexts answers OFFSCREEN_DOCUMENT from the offscreen emulation", async () => {
  const shim = buildShim({}, { "bg.js": "chrome.offscreen.createDocument({ url: 'off.html' })" });
  const nativeCalls = [];
  const getContexts = (filter) => { nativeCalls.push(filter); return Promise.resolve([{ contextType: "POPUP", documentUrl: EXT_ORIGIN + "/popup.html" }]); };
  const browser = fakeBrowser();
  browser.runtime.getContexts = getContexts;
  const ctx = runInContext(shim, { browser, href: EXT_ORIGIN + "/popup.html" });

  assert.deepEqual(plain(await vm.runInContext("chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })", ctx)), []);
  assert.equal(nativeCalls.length, 0, "Firefox never sees a filter naming only OFFSCREEN_DOCUMENT");

  await browser.storage.session.set({ __lavaductOffscreenDocument: EXT_ORIGIN + "/off.html" });
  const found = plain(await vm.runInContext("chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT', 'POPUP'] })", ctx));
  assert.deepEqual(plain(nativeCalls[0]), { contextTypes: ["POPUP"] });
  assert.deepEqual(found.map((c) => c.contextType), ["POPUP", "OFFSCREEN_DOCUMENT"]);
  assert.equal(found[1].documentUrl, EXT_ORIGIN + "/off.html");
  const byUrl = plain(await vm.runInContext(`chrome.runtime.getContexts({ documentUrls: ["${EXT_ORIGIN}/other.html"] })`, ctx));
  assert.deepEqual(byUrl.map((c) => c.contextType), ["POPUP"], "the offscreen document is only listed when the filter matches it");
});

test("the offscreen emulation records its document for the add-on's other pages", async () => {
  const shim = buildShim({}, { "bg.js": "chrome.offscreen.createDocument({ url: 'off.html' })" });
  const browser = fakeBrowser();
  browser.storage.session.data.__lavaductOffscreenDocument = EXT_ORIGIN + "/stale.html";
  const body = { appendChild(f) { f.parentNode = body; }, removeChild() {} };
  const document = {
    body,
    createElement: () => ({ setAttribute() {}, style: {}, addEventListener(type, fn) { if (type === "load") setTimeout(fn, 0); } }),
  };
  const ctx = runInContext(shim, { browser, globals: { document } });
  await tick();
  assert.equal("__lavaductOffscreenDocument" in browser.storage.session.data, false, "a new event page starts without one");
  await vm.runInContext("chrome.offscreen.createDocument({ url: 'off.html', reasons: ['AUDIO_PLAYBACK'], justification: 'x' })", ctx);
  assert.equal(browser.storage.session.data.__lavaductOffscreenDocument, EXT_ORIGIN + "/off.html");
  await vm.runInContext("chrome.offscreen.closeDocument()", ctx);
  await tick();
  assert.equal("__lavaductOffscreenDocument" in browser.storage.session.data, false);
});

test("storage.session.setAccessLevel settles, so code waiting on it carries on", async () => {
  const browser = fakeBrowser();
  const ctx = runInContext(buildShim(), { browser });
  await vm.runInContext("new Promise((resolve) => chrome.storage.session.setAccessLevel({ accessLevel: chrome.storage.AccessLevel.TRUSTED_AND_UNTRUSTED_CONTEXTS }, resolve))", ctx);
  await assert.rejects(vm.runInContext("chrome.storage.session.setAccessLevel({ accessLevel: 'EVERYONE' })", ctx), /Invalid access level/);
});

test("identity.AccountStatus exists where Firefox has identity", () => {
  const browser = fakeBrowser({ extra: { identity: { launchWebAuthFlow: () => Promise.resolve("") } } });
  runInContext(buildShim(), { browser });
  assert.deepEqual(plain(browser.identity.AccountStatus), { SYNC: "SYNC", ANY: "ANY" });
});

test("a content script finds the API on window.chrome as well as on chrome", () => {
  const pageWindow = {};
  const browser = fakeBrowser();
  const ctx = runInContext(buildShim(), { browser, href: "https://example.com/", globals: { window: pageWindow } });
  assert.equal(pageWindow.chrome, ctx.chrome);
  assert.equal(Object.keys(pageWindow).length, 1);

  const pageOwn = {};
  runInContext(buildShim(), { browser: fakeBrowser(), href: EXT_ORIGIN + "/popup.html", globals: { window: pageOwn } });
  assert.equal("chrome" in pageOwn, false, "extension pages already have window.chrome");
});

test("an IPv6 address in a runtime rule's domains gets the brackets Firefox wants", () => {
  const calls = [];
  const browser = fakeBrowser({ extra: { declarativeNetRequest: { updateDynamicRules: (o) => { calls.push(o); return Promise.resolve(); } } } });
  const ctx = runInContext(buildShim(), { browser });
  vm.runInContext(
    "chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1, priority: 1, action: { type: 'allow' }, condition: { requestDomains: ['localhost', '::1', '[::2]', '2001:db8:0:0:0:0:0:1'] } }] })",
    ctx,
  );
  assert.deepEqual(plain(calls[0]).addRules[0].condition.requestDomains, ["localhost", "[::1]", "[::2]", "[2001:db8::1]"]);
});

test("storage.managed.get() without a policy answers like an empty area, as Chrome's does; other failures still fail", async () => {
  const browser = fakeBrowser();
  let failure = "Managed storage manifest not found";
  browser.storage.managed = { get: () => Promise.reject(new Error(failure)) };
  const ctx = runInContext(buildShim(), { browser });
  assert.deepEqual(plain(await vm.runInContext("chrome.storage.managed.get('Mode')", ctx)), {});
  // Defaults come back as given, which code merges with storage.local.
  assert.deepEqual(plain(await vm.runInContext("chrome.storage.managed.get({ period: 600, list: [] })", ctx)), { period: 600, list: [] });
  const viaCallback = await vm.runInContext("new Promise((resolve) => chrome.storage.managed.get(['Mode'], (items) => resolve([items, chrome.runtime.lastError])))", ctx);
  assert.deepEqual(plain(viaCallback), [{}, null]);
  failure = "Something else";
  await assert.rejects(vm.runInContext("chrome.storage.managed.get()", ctx), /Something else/);
});

test("user script events wait for Firefox's runtime grant, and keep the listeners added before it", async () => {
  const browser = fakeBrowser();
  const onAdded = [];
  browser.permissions = { onAdded: { addListener: (fn) => onAdded.push(fn) } };
  const ctx = runInContext(buildShim({ userScripts: true }), { browser });
  vm.runInContext("globalThis.got = []; chrome.runtime.onUserScriptMessage.addListener((m) => got.push(m));", ctx);

  // Firefox defines its events when the user grants the permission.
  const real = [];
  browser.runtime.onUserScriptMessage = { addListener: (fn) => real.push(fn) };
  browser.runtime.onUserScriptConnect = { addListener: (fn) => real.push(fn) };
  onAdded.forEach((fn) => fn({ permissions: ["userScripts"] }));
  assert.equal(real.length, 1);
  real[0]("hi");
  assert.deepEqual(plain(ctx.got), ["hi"]);
});

test("user scripts get Chrome's runtime.id in their world, and getScripts hides how", async () => {
  const browser = fakeBrowser();
  const registered = [];
  browser.permissions = { onAdded: { addListener() {} } };
  browser.userScripts = {
    register: (scripts) => { registered.push(...scripts); return Promise.resolve(); },
    getScripts: () => Promise.resolve(registered),
  };
  const ctx = runInContext(buildShim({ userScripts: true }), { browser });
  await vm.runInContext("chrome.userScripts.register([{ id: 'a', matches: ['<all_urls>'], js: [{ file: 'u.js' }] }, { id: 'm', world: 'MAIN', matches: ['<all_urls>'], js: [{ file: 'm.js' }] }])", ctx);
  assert.equal(registered[0].js.length, 2);
  assert.deepEqual(plain(registered[1].js), [{ file: "m.js" }], "the page's own world is left alone");

  const worldRuntime = {};
  new Function("chrome", registered[0].js[0].code)({ runtime: worldRuntime });
  assert.equal(worldRuntime.id, "addon@example.test");
  assert.equal(typeof worldRuntime.onMessage.addListener, "function");

  const listed = plain(await vm.runInContext("chrome.userScripts.getScripts()", ctx));
  assert.deepEqual(listed[0].js, [{ file: "u.js" }]);
});

test("an add-on that never asks for userScripts gets no stand-in events", () => {
  const browser = fakeBrowser();
  browser.permissions = { onAdded: { addListener() {} } };
  runInContext(buildShim(), { browser });
  assert.equal(browser.runtime.onUserScriptMessage, undefined);
});

test("webpack chunks loaded ahead of a worker's runtime are installed when it takes over the chunk array", () => {
  const ctx = runInContext(buildShim({ webpackChunkGlobal: "webpackChunkapp" }), { browser: fakeBrowser() });
  vm.runInContext('(globalThis.webpackChunkapp = globalThis.webpackChunkapp || []).push([[719], { 719: () => "sdk" }]);', ctx);
  // Webpack 5's importScripts runtime only installs pushes made after it replaces push.
  vm.runInContext(
    "var modules = {}; var arr = globalThis.webpackChunkapp = globalThis.webpackChunkapp || [], parent = arr.push.bind(arr);" +
      "arr.push = (c) => { for (var id in c[1]) modules[id] = c[1][id]; parent(c); };",
    ctx,
  );
  assert.equal(vm.runInContext("typeof modules[719]", ctx), "function", "the chunk queued before the runtime is installed");
  vm.runInContext('globalThis.webpackChunkapp.push([[25], { 25: () => 1 }]);', ctx);
  assert.equal(vm.runInContext("typeof modules[25]", ctx), "function", "later chunks go straight to the runtime");

  const page = runInContext(buildShim({ webpackChunkGlobal: "webpackChunkapp" }), { browser: fakeBrowser(), href: EXT_ORIGIN + "/popup.html" });
  assert.equal(page.webpackChunkapp, undefined, "the add-on's pages are left alone");
});

test("a background that was a service worker has the registration its bundle reads, unless the bundle would take it for web push", () => {
  const files = { "sw.js": 'self.registration.addEventListener("updatefound", f); if (self.serviceWorker?.state === "activated") go();' };
  const config = { serviceWorker: true, serviceWorkerScript: "sw.js" };
  const ctx = runInContext(buildShim(config, files), { browser: fakeBrowser(), globals: { EventTarget, MessageEvent } });
  assert.equal(vm.runInContext("self.serviceWorker.state", ctx), "activated");
  assert.equal(vm.runInContext("self.registration.active.scriptURL", ctx), EXT_ORIGIN + "/sw.js");
  assert.equal(vm.runInContext("typeof self.registration.addEventListener", ctx), "function");

  const push = runInContext(buildShim(config, { ...files, "push.js": "reg.pushManager.subscribe()" }), { browser: fakeBrowser(), globals: { EventTarget, MessageEvent } });
  assert.equal(vm.runInContext("typeof self.registration", push), "undefined", "Firefox gives add-ons no Push API");
});

test("the add-on's pages find its worker through navigator.serviceWorker", async () => {
  const files = { "sw.js": "self.clients.matchAll()", "page.js": "navigator.serviceWorker.ready" };
  const navigator = {};
  const document = { readyState: "complete", addEventListener() {} };
  const ctx = runInContext(buildShim({ serviceWorker: true, serviceWorkerScript: "sw.js" }, files), {
    browser: fakeBrowser(),
    href: EXT_ORIGIN + "/popup.html",
    globals: { navigator, document, EventTarget, MessageEvent, addEventListener() {} },
  });
  const reg = await vm.runInContext("navigator.serviceWorker.ready", ctx);
  assert.equal(reg.active.scriptURL, EXT_ORIGIN + "/sw.js");
  assert.equal(vm.runInContext("navigator.serviceWorker.controller", ctx), null, "no page is controlled: the event page can't answer its fetches");
  assert.equal(await vm.runInContext("navigator.serviceWorker.register('/sw.js')", ctx), reg);
  await assert.rejects(vm.runInContext("navigator.serviceWorker.register('/other.js')", ctx));
});

test("a lock the event page takes under its own location is taken under the worker script's", () => {
  const taken = [];
  const navigator = { locks: { request: (name) => { taken.push(name); return Promise.resolve(); } } };
  const ctx = runInContext(buildShim({ serviceWorker: true, serviceWorkerScript: "sw.js" }, { "sw.js": "navigator.locks.request(location.pathname, f)" }), {
    browser: fakeBrowser(),
    globals: { navigator },
  });
  vm.runInContext("navigator.locks.request(location.pathname, () => {}); navigator.locks.request('other', () => {})", ctx);
  assert.deepEqual(taken, ["/sw.js", "other"]);
});
