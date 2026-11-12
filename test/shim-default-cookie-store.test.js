import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, plain, runInContext, tick } from "./shim-sandbox.js";

// Firefox refuses any cookieStoreId, the default store's included, from an
// add-on without the `cookies` permission: tabs.create, windows.create and
// downloads.download reject with "No permission for cookieStoreId:
// firefox-default" and open nothing (measured in Firefox 160). A Chrome bundle
// that also ships to Firefox picks its Firefox branch by user agent and passes
// the tab's saved store there; its own Firefox build declares `cookies`, the
// Chrome manifest doesn't. Tab Session Manager 7.4.0 restored every session as
// empty windows: each tabs.create({ ..., cookieStoreId: "firefox-default" })
// was refused. Without the store id the tab lands in the default store, as
// with it, unless an opener tab's container would be inherited (measured) or
// the window is private, where Firefox refuses the default store either way.

const TSM = 'let o={active:e.active,index:e.index,pinned:e.pinned,url:e.url,windowId:n.id};"Firefox"==l()().name&&(o.cookieStoreId=e.cookieStoreId);const t=await browser.tabs.create(o);';
const REFUSED = (id) => `No permission for cookieStoreId: ${id}`;

function firefox({ cookies = false, manifestPermissions = ["tabs"], windows = {}, tabs = {}, incognitoAccess = false, lastFocused = { id: 1, type: "normal", incognito: false } } = {}) {
  const browser = fakeBrowser({ manifest: { manifest_version: 3, name: "T", version: "1", permissions: manifestPermissions } });
  const created = [];
  const attempts = [];
  const check = (what, props) => {
    attempts.push([what, plain(props)]);
    if (props && props.cookieStoreId != null && !cookies) return Promise.reject(new Error(REFUSED(props.cookieStoreId)));
    created.push([what, plain(props)]);
    return null;
  };
  browser.tabs = {
    query: () => Promise.resolve([]),
    get: (id) => (tabs[id] ? Promise.resolve(tabs[id]) : Promise.reject(new Error(`Invalid tab ID: ${id}`))),
    create(props) { return check("tabs.create", props) ?? Promise.resolve({ id: 100 + created.length, cookieStoreId: "firefox-default" }); },
  };
  browser.windows = {
    get: (id) => (windows[id] ? Promise.resolve(windows[id]) : Promise.reject(new Error(`Invalid window ID: ${id}`))),
    getLastFocused: () => Promise.resolve(lastFocused),
    create(props) { return check("windows.create", props) ?? Promise.resolve({ id: 200 + created.length }); },
  };
  browser.downloads = { download(props) { return check("downloads.download", props) ?? Promise.resolve(7); } };
  browser.extension = { getViews: () => [], isAllowedIncognitoAccess: () => Promise.resolve(incognitoAccess) };
  return { browser, created, attempts };
}

function setup(opts, bundle = TSM) {
  const ff = firefox(opts);
  const ctx = runInContext(buildShim({}, { "background.js": bundle }), { browser: ff.browser });
  return { ...ff, ctx };
}

const run = (ctx, code) => vm.runInContext(`(async () => { ${code} })()`, ctx);
const outcome = (ctx, code) => run(ctx, code).then((v) => ({ ok: plain(v) }), (e) => ({ error: e.message }));

test("tabs.create with the default store opens the tab in it without the cookies permission", async () => {
  const { ctx, created } = setup({ windows: { 5: { id: 5, incognito: false } } });
  const r = await outcome(ctx, 'return browser.tabs.create({ url: "https://example.com/", windowId: 5, index: 0, cookieStoreId: "firefox-default" });');
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(created, [["tabs.create", { url: "https://example.com/", windowId: 5, index: 0 }]]);
});

test("the callback form gets the tab and no lastError", async () => {
  const { ctx, browser } = setup({ windows: { 5: { id: 5, incognito: false } } });
  const seen = await new Promise((resolve) => {
    ctx.done = (tab) => resolve({ tab: plain(tab), lastError: browser.runtime.lastError });
    vm.runInContext('chrome.tabs.create({ url: "https://example.com/", windowId: 5, cookieStoreId: "firefox-default" }, done);', ctx);
  });
  assert.equal(seen.lastError, null);
  assert.equal(seen.tab.cookieStoreId, "firefox-default");
});

test("tabs.create with no window picks the top window, which is never private without private access", async () => {
  const { ctx, created } = setup({ incognitoAccess: false, lastFocused: { id: 1, type: "normal", incognito: true } });
  const r = await outcome(ctx, 'return browser.tabs.create({ url: "https://example.com/", cookieStoreId: "firefox-default" });');
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(created, [["tabs.create", { url: "https://example.com/" }]]);
});

test("a private target window keeps Firefox's refusal: the default store can't open there", async () => {
  for (const opts of [
    { windows: { 6: { id: 6, incognito: true } }, code: "windowId: 6," },
    { incognitoAccess: true, lastFocused: { id: 6, type: "normal", incognito: true }, code: "" },
    { incognitoAccess: true, lastFocused: { id: 8, type: "popup", incognito: false }, code: "" },
  ]) {
    const { ctx, created } = setup(opts);
    const r = await outcome(ctx, `return browser.tabs.create({ url: "https://example.com/", ${opts.code} cookieStoreId: "firefox-default" });`);
    assert.deepEqual(r, { error: REFUSED("firefox-default") }, JSON.stringify(opts));
    assert.deepEqual(created, []);
  }
});

test("an opener in a container keeps the refusal, since leaving the store out inherits its container", async () => {
  const { ctx, created } = setup({ tabs: { 3: { id: 3, cookieStoreId: "firefox-container-1" }, 4: { id: 4, cookieStoreId: "firefox-default" } } });
  const inContainer = await outcome(ctx, 'return browser.tabs.create({ url: "https://example.com/", openerTabId: 3, cookieStoreId: "firefox-default" });');
  assert.deepEqual(inContainer, { error: REFUSED("firefox-default") });
  const inDefault = await outcome(ctx, 'return browser.tabs.create({ url: "https://example.com/", openerTabId: 4, cookieStoreId: "firefox-default" });');
  assert.ok(inDefault.ok, JSON.stringify(inDefault));
  assert.deepEqual(created, [["tabs.create", { url: "https://example.com/", openerTabId: 4 }]]);
});

test("windows.create with the default store opens the window, unless it is private or adopts a tab from another store", async () => {
  const { ctx, created } = setup({ tabs: { 3: { id: 3, cookieStoreId: "firefox-container-1" }, 4: { id: 4, cookieStoreId: "firefox-default" } } });
  assert.ok((await outcome(ctx, 'return browser.windows.create({ url: ["https://a.test/"], cookieStoreId: "firefox-default" });')).ok);
  assert.ok((await outcome(ctx, 'return browser.windows.create({ tabId: 4, cookieStoreId: "firefox-default" });')).ok);
  assert.deepEqual(await outcome(ctx, 'return browser.windows.create({ url: "https://a.test/", incognito: true, cookieStoreId: "firefox-default" });'), { error: REFUSED("firefox-default") });
  assert.deepEqual(await outcome(ctx, 'return browser.windows.create({ tabId: 3, cookieStoreId: "firefox-default" });'), { error: REFUSED("firefox-default") });
  assert.deepEqual(created, [["windows.create", { url: ["https://a.test/"] }], ["windows.create", { tabId: 4 }]]);
});

test("downloads.download with the default store downloads, except into a private session", async () => {
  const { ctx, created } = setup({});
  assert.deepEqual(await outcome(ctx, 'return browser.downloads.download({ url: "https://a.test/f", cookieStoreId: "firefox-default" });'), { ok: 7 });
  assert.deepEqual(await outcome(ctx, 'return browser.downloads.download({ url: "https://a.test/f", incognito: true, cookieStoreId: "firefox-default" });'), { error: REFUSED("firefox-default") });
  assert.deepEqual(created, [["downloads.download", { url: "https://a.test/f" }]]);
});

test("other stores and other errors reach the add-on as Firefox gave them", async () => {
  const { ctx, attempts } = setup({});
  assert.deepEqual(await outcome(ctx, 'return browser.tabs.create({ url: "https://a.test/", cookieStoreId: "firefox-private" });'), { error: REFUSED("firefox-private") });
  assert.deepEqual(await outcome(ctx, 'return browser.tabs.create({ url: "https://a.test/", cookieStoreId: "firefox-container-2" });'), { error: REFUSED("firefox-container-2") });
  assert.equal(attempts.length, 2);
});

test("an add-on Firefox grants cookies keeps its store id and gets no wrapper", async () => {
  const { ctx, attempts, browser } = setup({ cookies: true, manifestPermissions: ["tabs", "cookies"], windows: { 5: { id: 5, incognito: false } } });
  assert.ok((await outcome(ctx, 'return browser.tabs.create({ url: "https://a.test/", windowId: 5, cookieStoreId: "firefox-default" });')).ok);
  assert.deepEqual(attempts, [["tabs.create", { url: "https://a.test/", windowId: 5, cookieStoreId: "firefox-default" }]]);
  assert.equal(Object.getOwnPropertyDescriptor(browser.tabs, "create").value.name, "create");
});

test("a bundle that never names cookieStoreId keeps Firefox's tabs.create", () => {
  const { browser } = setup({}, 'browser.tabs.create({ url: "https://a.test/" });');
  assert.equal(browser.tabs.create.name, "create");
  assert.equal(browser.windows.create.name, "create");
});

test("a store id the default lookup can't confirm keeps the refusal", async () => {
  const { ctx, created } = setup({});
  const r = await outcome(ctx, 'return browser.tabs.create({ url: "https://a.test/", windowId: 99, cookieStoreId: "firefox-default" });');
  assert.deepEqual(r, { error: REFUSED("firefox-default") });
  await tick();
  assert.deepEqual(created, []);
});
