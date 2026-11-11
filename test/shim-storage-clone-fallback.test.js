import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain } from "./shim-sandbox.js";

// Chrome's storage.set serializes values: a function, or an object with no
// own enumerable data (a URL), is stored as {}. Firefox structured-clones them
// and refuses the whole call (measured in Firefox 160, local, sync and session
// alike): the promise rejects with "DataCloneError: Function object could not
// be cloned.", the callback form sees it as lastError, and nothing is stored.
// Rabby keeps its security-engine rules, each with a getValue function, in
// storage.local; in Firefox none of them were saved.

function cloneError(e) {
  const err = new Error(`DataCloneError: ${e.message}`);
  return err;
}

// A storage area that clones like Firefox's.
function firefoxArea(browser) {
  const data = {};
  return {
    data,
    set(items, cb) {
      let copy;
      try { copy = structuredClone(items); } catch (e) {
        if (!cb) return Promise.reject(cloneError(e));
        queueMicrotask(() => { browser.runtime.nativeLastError = { message: cloneError(e).message }; cb(); browser.runtime.nativeLastError = null; });
        return undefined;
      }
      Object.assign(data, copy);
      if (cb) { queueMicrotask(() => cb()); return undefined; }
      return Promise.resolve();
    },
    get() { return Promise.resolve(structuredClone(data)); },
  };
}

function setup(code = "chrome.storage.local.set({ a: 1 });") {
  const browser = fakeBrowser();
  browser.storage.local = firefoxArea(browser);
  browser.storage.session = firefoxArea(browser);
  const nativeSet = browser.storage.local.set;
  const ctx = runInContext(buildShim({}, { "bg.js": code }), { browser });
  return { browser, ctx, nativeSet };
}

test("storage.set with a function or URL stores them as Chrome does, as {}", async () => {
  const { browser, ctx } = setup();
  await vm.runInContext(`chrome.storage.local.set({
    rules: [{ id: "1001", enable: true, getValue() {} }],
    when: new Date(5),
    link: new URL("https://a.test/"),
    nested: { list: [1, () => 2], ok: "x" },
  })`, ctx);
  const d = browser.storage.local.data;
  assert.deepEqual(plain(d.rules), [{ id: "1001", enable: true, getValue: {} }]);
  assert.deepEqual(plain(d.link), {});
  assert.deepEqual(plain(d.nested), { list: [1, {}], ok: "x" });
  assert.ok(d.when instanceof Date && d.when.getTime() === 5, "what Firefox can clone keeps Firefox's clone");

  await vm.runInContext("chrome.storage.session.set({ f() {} })", ctx);
  assert.deepEqual(plain(browser.storage.session.data), { f: {} });
});

test("the callback form hears success, not the clone error", async () => {
  const { browser, ctx } = setup();
  const lastError = await new Promise((resolve) => {
    ctx.done = () => resolve(ctx.chrome.runtime.lastError);
    vm.runInContext("chrome.storage.local.set({ f: function () {} }, done)", ctx);
  });
  assert.equal(lastError, null);
  assert.deepEqual(plain(browser.storage.local.data), { f: {} });
});

test("a cycle in a value Firefox can't clone is cut instead of recursed into, and cloneable values go to Firefox untouched", async () => {
  const { browser, ctx } = setup();
  await vm.runInContext("const o = { f() {}, n: 1 }; o.self = o; chrome.storage.local.set({ o })", ctx);
  assert.deepEqual(plain(browser.storage.local.data.o), { f: {}, n: 1 });
  await vm.runInContext("globalThis.v = { m: new Map([[1, 2]]) }; chrome.storage.local.set({ v })", ctx);
  assert.ok(browser.storage.local.data.v.m instanceof Map, "a Map Firefox can clone stays a Map");
});

test("a bundle that never touches storage keeps Firefox's set", () => {
  const { browser, nativeSet } = setup("chrome.runtime.getURL('x');");
  assert.equal(browser.storage.local.set, nativeSet);
});
