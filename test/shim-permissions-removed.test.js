import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain } from "./shim-sandbox.js";

// The conversion removes the permissions Firefox doesn't know, offscreen and
// sidePanel among them, and the shim emulates those APIs. Firefox's
// permissions.contains/request/remove throw synchronously on a name they don't
// know (measured in Firefox 159: "Type error for parameter permissions"), where
// Chrome answers: true for a permission the manifest granted. Speechify checks
// contains({ permissions: ["offscreen"] }) before it creates its offscreen
// document, so the document was never created.

const FIREFOX_KNOWS = new Set(["storage", "tabs", "notifications"]);

function firefoxPermissions(granted, calls) {
  const check = (p) => {
    for (const name of (p && p.permissions) || []) {
      if (!FIREFOX_KNOWS.has(name)) throw new TypeError(`Type error for parameter permissions (Error processing permissions.0: Value "${name}" must either: …)`);
    }
  };
  return {
    contains(p) { calls.push(["contains", p]); check(p); return Promise.resolve((p.permissions || []).every((n) => granted.has(n))); },
    request(p) { calls.push(["request", p]); check(p); for (const n of p.permissions || []) granted.add(n); return Promise.resolve(true); },
    remove(p) { calls.push(["remove", p]); check(p); return Promise.resolve(true); },
    getAll() { calls.push(["getAll"]); return Promise.resolve({ origins: [], permissions: [...granted] }); },
  };
}

function setup({ declared = ["offscreen", "storage", "tts"], code = "chrome.permissions.contains({ permissions: ['offscreen'] })" } = {}) {
  const calls = [];
  const browser = fakeBrowser();
  const native = firefoxPermissions(new Set(["storage"]), calls);
  browser.permissions = { ...native };
  const ctx = runInContext(buildShim({ declaredPermissions: declared }, { "bg.js": code }), { browser });
  return { browser, native, calls, ctx };
}

test("contains answers for removed permissions: true for the ones the shim emulates and the manifest asked for", async () => {
  const { ctx, calls } = setup();
  const ask = (perms) => vm.runInContext(`chrome.permissions.contains({ permissions: ${JSON.stringify(perms)} })`, ctx);
  assert.equal(await ask(["offscreen"]), true);
  assert.equal(calls.length, 0, "Firefox never sees a name it would throw on");
  assert.equal(await ask(["tts"]), false, "removed and not emulated: the API isn't there");
  assert.equal(await ask(["sidePanel"]), false, "emulated, but the manifest never asked for it");
  assert.equal(await ask(["offscreen", "storage"]), true);
  assert.deepEqual(plain(calls.at(-1)), ["contains", { permissions: ["storage"] }], "the rest still goes to Firefox");
  assert.equal(await ask(["offscreen", "notifications"]), false);
  let returned = null;
  const viaCallback = await new Promise((resolve) => {
    ctx.done = resolve;
    returned = vm.runInContext("chrome.permissions.contains({ permissions: ['offscreen'] }, done)", ctx);
  });
  assert.equal(viaCallback, true);
  assert.equal(returned, undefined, "the callback form returns nothing");
});

test("a call without a removed name goes to Firefox untouched", async () => {
  const { ctx, calls } = setup();
  const filter = vm.runInContext("globalThis.f = { permissions: ['storage'], origins: [] }", ctx);
  assert.equal(await vm.runInContext("chrome.permissions.contains(f)", ctx), true);
  assert.equal(calls[0][1], filter, "the add-on's own object reaches Firefox");
});

test("request grants emulated names without a prompt, forwards the rest in the same turn, and refuses what can't be had", async () => {
  const { ctx, calls } = setup();
  assert.equal(await vm.runInContext("chrome.permissions.request({ permissions: ['offscreen'] })", ctx), true);
  assert.equal(calls.length, 0);
  const p = vm.runInContext("chrome.permissions.request({ permissions: ['offscreen', 'tabs'] })", ctx);
  assert.deepEqual(plain(calls.at(-1)), ["request", { permissions: ["tabs"] }], "forwarded before anything is awaited: Firefox needs the user action");
  assert.equal(await p, true);
  const before = calls.length;
  assert.equal(await vm.runInContext("chrome.permissions.request({ permissions: ['tts', 'tabs'] })", ctx), false);
  assert.equal(calls.length, before, "no prompt for a request that can't be granted in full");
});

test("getAll lists the emulated permissions the manifest asked for, and remove never throws on them", async () => {
  const { ctx } = setup();
  const all = plain(await vm.runInContext("chrome.permissions.getAll()", ctx));
  assert.deepEqual(all.permissions.sort(), ["offscreen", "storage"]);
  assert.equal(await vm.runInContext("chrome.permissions.remove({ permissions: ['offscreen'] })", ctx), false);
});

test("a bundle that never calls permissions keeps Firefox's functions", () => {
  const { browser, native } = setup({ code: "chrome.offscreen.createDocument({})" });
  assert.equal(browser.permissions.contains, native.contains);
  assert.equal(browser.permissions.request, native.request);
});
