import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, plain, runInContext } from "./shim-sandbox.js";

// Code built for both browsers passes an event's filter as `isFirefox && {…}`,
// and a Chrome build compiles that to addListener(fn, false). Firefox's schema
// refuses false, 0 or "" where a filter object or nothing goes ("Incorrect
// argument types for tabs.onUpdated", measured in Firefox 160), and the throw
// ends the script. Violentmonkey 2.50.0 probes tabs.onUpdated with a filter,
// which Chrome refuses and Firefox accepts, so it never strips the argument,
// then registers its .user.js install listener with `!1`: its background
// stopped there, and visiting a .user.js URL installed nothing.

// An event that checks its arguments the way Firefox's Schemas.sys.mjs does:
// the optional filter is an object, or null/undefined for none.
function firefoxEvent(name, { params = 1 } = {}) {
  const listeners = [];
  return {
    listeners,
    addListener(fn, ...rest) {
      if (rest.length > params || rest.some((a) => a !== null && a !== undefined && typeof a !== "object")) {
        throw new Error(`Incorrect argument types for ${name}.`);
      }
      listeners.push({ fn, rest });
    },
    removeListener(fn) { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.some((l) => l.fn === fn); },
  };
}

function setup(bundle) {
  const browser = fakeBrowser();
  browser.tabs.onUpdated = firefoxEvent("tabs.onUpdated");
  browser.alarms = { onAlarm: firefoxEvent("alarms.onAlarm", { params: 0 }) };
  browser.storage.local.onChanged = firefoxEvent("storage.local.onChanged", { params: 0 });
  const ctx = runInContext(buildShim({}, { "sw.js": bundle }), { browser });
  return { browser, ctx };
}

const VIOLENTMONKEY = 'try{pr.addListener(de,{properties:["status"]}),pr.removeListener(de)}catch(e){}pr.addListener(async(e,{url:t},n)=>{if(!t)return},!1);';

test("a listener added with a false filter is registered, as the add-on meant", () => {
  const { browser, ctx } = setup(VIOLENTMONKEY);
  vm.runInContext(`
    globalThis.a = () => {}; globalThis.b = () => {}; globalThis.c = () => {};
    chrome.tabs.onUpdated.addListener(a, false);
    browser.alarms.onAlarm.addListener(b, 0);
    chrome.storage.local.onChanged.addListener(c, "");
  `, ctx);
  assert.deepEqual(browser.tabs.onUpdated.listeners.map((l) => [l.fn, l.rest.length]), [[ctx.a, 0]]);
  assert.deepEqual(browser.alarms.onAlarm.listeners.map((l) => l.fn), [ctx.b]);
  assert.deepEqual(browser.storage.local.onChanged.listeners.map((l) => l.fn), [ctx.c]);
  assert.equal(vm.runInContext("chrome.tabs.onUpdated.hasListener(a)", ctx), true);
  vm.runInContext("chrome.tabs.onUpdated.removeListener(a)", ctx);
  assert.equal(browser.tabs.onUpdated.listeners.length, 0);
});

test("a real filter still reaches Firefox, and a wrong one still throws", () => {
  const { browser, ctx } = setup(VIOLENTMONKEY);
  vm.runInContext(`globalThis.a = () => {}; chrome.tabs.onUpdated.addListener(a, { properties: ["status"] });`, ctx);
  assert.deepEqual(plain(browser.tabs.onUpdated.listeners[0].rest), [{ properties: ["status"] }]);
  assert.throws(() => vm.runInContext(`chrome.tabs.onUpdated.addListener(() => {}, "status", {})`, ctx), /Incorrect argument types/);
});

test("a filter that can be false at runtime turns the fix on too", () => {
  const { browser, ctx } = setup('chrome.tabs.onUpdated.addListener(fn, isFirefox && { properties: ["url"] });');
  vm.runInContext(`chrome.tabs.onUpdated.addListener(() => {}, false);`, ctx);
  assert.equal(browser.tabs.onUpdated.listeners.length, 1);
});

test("a bundle that never passes a falsy filter keeps Firefox's addListener", () => {
  const browser = fakeBrowser();
  const onUpdated = firefoxEvent("tabs.onUpdated");
  const add = onUpdated.addListener;
  browser.tabs.onUpdated = onUpdated;
  runInContext(buildShim({}, { "sw.js": 'chrome.tabs.onUpdated.addListener(f, { properties: ["status"] }); a.addListener(g); w.addListener(h, x ? ["blocking"] : y && z);' }), { browser });
  assert.equal(onUpdated.addListener, add);
});
