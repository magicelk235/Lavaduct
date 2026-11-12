import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, makeEvent, makeStorageArea, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Firefox's storage.session is closed to content scripts and has no
// setAccessLevel; the shim backfills setAccessLevel so a background waiting on
// it doesn't hang (Grammarly). Vimium 2.4.2 then believes it has Chrome's
// session area: its background keeps the key mappings there after
// setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }), while its
// content scripts, finding no storage.session, fall back to storage.local
// (lib/utils.js), read undefined and throw on every key (mode_key_handler.js:91).

const BG_CODE = 'chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });';

// The background's session area, with Firefox's storage.session.onChanged.
function sessionArea() {
  const area = makeStorageArea();
  const onChanged = makeEvent();
  const set = area.set;
  area.onChanged = onChanged;
  area.set = (items) => {
    const changes = {};
    for (const [k, v] of Object.entries(items)) changes[k] = { oldValue: area.data[k], newValue: v };
    return set.call(area, items).then(() => { onChanged.fire(structuredClone(changes)); });
  };
  area.clear = () => { for (const k of Object.keys(area.data)) delete area.data[k]; return Promise.resolve(); };
  return area;
}

// A background, one content script, and one of the add-on's pages framed in
// the web page (Firefox gives it no session area either), wired like Firefox's
// messaging.
function setup(code = BG_CODE, { level = true } = {}) {
  const bg = fakeBrowser();
  bg.storage.session = sessionArea();
  const cs = fakeBrowser();
  delete cs.storage.session;
  const pg = fakeBrowser();
  delete pg.storage.session;
  const deliver = (event, message, sender) => new Promise((resolve) => {
    let answered = false;
    for (const fn of event.listeners) {
      const r = fn(message, sender, (v) => { answered = true; resolve(v); });
      if (r && typeof r.then === "function") { answered = true; r.then(resolve); }
    }
    if (!answered) resolve(undefined);
  });
  const pageUrl = EXT_ORIGIN + "/pages/vomnibar_page.html";
  cs.runtime.sendMessage = (message) => deliver(bg.runtime.onMessage, structuredClone(message), { tab: { id: 7 }, frameId: 0, url: "https://site.test/" });
  pg.runtime.sendMessage = (message) => deliver(bg.runtime.onMessage, structuredClone(message), { tab: { id: 7 }, frameId: 3, url: pageUrl });
  bg.runtime.sendMessage = (message) => deliver(pg.runtime.onMessage, structuredClone(message), { id: "addon@example.test", url: EXT_ORIGIN + "/_generated_background_page.html" });
  bg.tabs = {
    query: () => Promise.resolve([{ id: 7 }]),
    sendMessage: (tabId, message) => deliver(cs.runtime.onMessage, structuredClone(message), { id: "addon@example.test" }),
  };
  const shim = buildShim({}, { "bg.js": code, "cs.js": "chrome.storage.session.get('k')" });
  const bgCtx = runInContext(shim, { browser: bg });
  vm.runInContext(level ? code : "", bgCtx);
  const csCtx = runInContext(shim, { browser: cs, href: "https://site.test/page" });
  const pgCtx = runInContext(shim, { browser: pg, href: pageUrl, globals: { top: {} } });
  return { bg, cs, pg, bgCtx, csCtx, pgCtx };
}

test("content scripts get the session area once the background opens it to them", async () => {
  const { bg, csCtx, bgCtx } = setup();
  // The add-on's own listeners never see the shim's messages.
  vm.runInContext("globalThis.seen = []; chrome.runtime.onMessage.addListener((m) => { seen.push(m); });", bgCtx);
  await bg.storage.session.set({ normalModeKeyStateMapping: { j: "scrollDown" } });
  assert.equal(vm.runInContext("typeof chrome.storage.session.setAccessLevel", csCtx), "function", "Vimium's lib/utils.js keeps the area");
  const got = await vm.runInContext("chrome.storage.session.get('normalModeKeyStateMapping')", csCtx);
  assert.deepEqual(plain(got), { normalModeKeyStateMapping: { j: "scrollDown" } });
  const viaCallback = await vm.runInContext("new Promise((r) => chrome.storage.session.get(null, (items) => r([items, chrome.runtime.lastError])))", csCtx);
  assert.deepEqual(plain(viaCallback), [{ normalModeKeyStateMapping: { j: "scrollDown" } }, null]);
  await vm.runInContext("chrome.storage.session.set({ passNextKeyKeys: ['a'] })", csCtx);
  assert.deepEqual(plain(bg.storage.session.data.passNextKeyKeys), ["a"]);
  await vm.runInContext("chrome.storage.session.remove('passNextKeyKeys')", csCtx);
  assert.equal("passNextKeyKeys" in bg.storage.session.data, false);
  assert.deepEqual(plain(bgCtx.seen), []);
});

test("content scripts hear the session area's changes on storage.onChanged and storage.session.onChanged", async () => {
  const { bg, cs, csCtx } = setup();
  const firefoxOnChanged = cs.storage.onChanged;
  vm.runInContext(`globalThis.changes = [];
    globalThis.l = (c, area) => changes.push([area, c]);
    chrome.storage.onChanged.addListener(l);
    chrome.storage.session.onChanged.addListener((c) => changes.push(["session.onChanged", c]));
    globalThis.own = []; chrome.runtime.onMessage.addListener((m) => { own.push(m); });`, csCtx);
  assert.equal(cs.storage.onChanged, firefoxOnChanged, "storage.onChanged stays Firefox's event");
  assert.equal(firefoxOnChanged.listeners.length, 1, "the listener is Firefox's too, for local and sync");
  await bg.storage.session.set({ mapKeyRegistry: { f: 1 } });
  await tick(5);
  assert.deepEqual(plain(csCtx.changes), [
    ["session.onChanged", { mapKeyRegistry: { newValue: { f: 1 } } }],
    ["session", { mapKeyRegistry: { newValue: { f: 1 } } }],
  ]);
  assert.deepEqual(plain(csCtx.own), [], "the change broadcast is hidden from the add-on's onMessage");
  vm.runInContext("chrome.storage.onChanged.removeListener(l)", csCtx);
  await bg.storage.session.set({ mapKeyRegistry: { f: 2 } });
  await tick(5);
  assert.equal(csCtx.changes.length, 3, "a removed listener hears nothing");
});

test("until the access level is raised, content scripts are refused as in Chrome, and the add-on's pages are not", async () => {
  const { bg, csCtx, pgCtx } = setup(BG_CODE, { level: false });
  await bg.storage.session.set({ secret: 1 });
  await assert.rejects(vm.runInContext("chrome.storage.session.get('secret')", csCtx), /Access to storage is not allowed from this context/);
  const err = await vm.runInContext("new Promise((r) => chrome.storage.session.get('secret', () => r(chrome.runtime.lastError && chrome.runtime.lastError.message)))", csCtx);
  assert.match(err, /not allowed/);
  await assert.rejects(vm.runInContext("chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })", csCtx), /not allowed/);
  assert.deepEqual(plain(await vm.runInContext("chrome.storage.session.get('secret')", pgCtx)), { secret: 1 });
  // A page may raise it, as in Chrome.
  await vm.runInContext("chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })", pgCtx);
  assert.deepEqual(plain(await vm.runInContext("chrome.storage.session.get('secret')", csCtx)), { secret: 1 });
});

test("an add-on page framed in a web page, which Firefox gives no session area, shares the background's (Vimium's Vomnibar secret)", async () => {
  const { bg, pgCtx } = setup();
  await bg.storage.session.set({ vimiumSecret: "s3cret" });
  assert.equal(vm.runInContext("typeof chrome.storage.session.setAccessLevel", pgCtx), "function");
  assert.deepEqual(plain(await vm.runInContext("chrome.storage.session.get('vimiumSecret')", pgCtx)), { vimiumSecret: "s3cret" });
  vm.runInContext("globalThis.changes = []; chrome.storage.onChanged.addListener((c, area) => changes.push([area, c]));", pgCtx);
  await bg.storage.session.set({ vimiumSecret: "next" });
  await tick(5);
  assert.deepEqual(plain(pgCtx.changes), [["session", { vimiumSecret: { oldValue: "s3cret", newValue: "next" } }]]);
});

test("an add-on that never calls setAccessLevel gets no session area in content scripts", () => {
  const cs = fakeBrowser();
  delete cs.storage.session;
  const ctx = runInContext(buildShim({}, { "cs.js": "chrome.storage.local.get('k')" }), { browser: cs, href: "https://site.test/" });
  assert.equal(vm.runInContext("chrome.storage.session", ctx), undefined);
});
