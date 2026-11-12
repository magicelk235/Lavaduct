import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain } from "./shim-sandbox.js";

// Firefox declares some methods Chrome gives a callback as promise-only
// ("async": true in its schemas) and throws "Incorrect argument types" on a
// trailing function: userScripts.register/update/unregister/configureWorld/
// resetWorldConfiguration, action.(get|set)BadgeTextColor/isEnabled/openPopup
// (browserAction imports them), pageAction.setPopup, tabs.discard/ungroup.
// Surfingkeys calls chrome.userScripts.register([...], cb), so its snippets
// never registered.

// A promise-only method as Firefox's schema checks it.
function promiseOnly(calls, name, result, fail) {
  return function (...args) {
    if (args.length && typeof args[args.length - 1] === "function") throw new Error(`Incorrect argument types for ${name}.`);
    calls.push([name, ...args]);
    return fail ? Promise.reject(new Error(fail)) : Promise.resolve(result);
  };
}

function userScriptsBrowser() {
  const browser = fakeBrowser();
  const calls = [];
  const registered = [];
  browser.permissions = { onAdded: { addListener() {} } };
  browser.userScripts = {
    register: (scripts, ...rest) => {
      if (rest.length && typeof rest[rest.length - 1] === "function") throw new Error("Incorrect argument types for userScripts.register.");
      registered.push(...scripts);
      return Promise.resolve();
    },
    update: promiseOnly(calls, "userScripts.update"),
    unregister: promiseOnly(calls, "userScripts.unregister", undefined, "Nothing to unregister"),
    configureWorld: promiseOnly(calls, "userScripts.configureWorld"),
    resetWorldConfiguration: promiseOnly(calls, "userScripts.resetWorldConfiguration"),
    // Firefox takes getScripts' callback itself.
    getScripts: (filter, cb) => {
      if (typeof cb === "function") { queueMicrotask(() => cb(registered)); return undefined; }
      return Promise.resolve(registered);
    },
  };
  return { browser, calls, registered };
}

test("userScripts.register and friends call Chrome's callback instead of refusing it", async () => {
  const { browser, calls, registered } = userScriptsBrowser();
  const ctx = runInContext(buildShim({ userScripts: true }), { browser });
  const result = await vm.runInContext(`new Promise((resolve) => {
    const out = {};
    const ret = chrome.userScripts.register([{ id: "s", matches: ["*://*/*"], js: [{ code: "1" }] }], () => {
      out.register = [ret, chrome.runtime.lastError];
      chrome.userScripts.configureWorld({ messaging: true }, () => {
        out.configureWorld = chrome.runtime.lastError;
        chrome.userScripts.unregister({ ids: ["s"] }, () => {
          out.unregister = chrome.runtime.lastError && chrome.runtime.lastError.message;
          out.after = chrome.runtime.lastError;
          chrome.userScripts.getScripts({ ids: ["s"] }, (list) => { out.getScripts = list; resolve(out); });
        });
      });
    });
  })`, ctx);
  assert.equal(registered.length, 1, "the snippet is registered");
  assert.equal(result.register[0], undefined, "a call with a callback returns nothing, as in Chrome");
  assert.equal(result.register[1], null, "no lastError on success");
  assert.equal(result.configureWorld, null);
  assert.deepEqual(plain(calls.find((c) => c[0] === "userScripts.configureWorld")), ["userScripts.configureWorld", { messaging: true }]);
  assert.equal(result.unregister, "Nothing to unregister", "a rejection reaches the callback as runtime.lastError");
  assert.deepEqual(plain(result.getScripts)[0].js, [{ code: "1" }], "getScripts' callback doesn't see the shim's prelude");
  // Promise use is untouched.
  await vm.runInContext("chrome.userScripts.update([{ id: 's', js: [{ code: '2' }] }])", ctx);
  await assert.rejects(vm.runInContext("chrome.userScripts.unregister({ ids: ['s'] })", ctx), /Nothing to unregister/);
});

test("action, pageAction and tabs methods Firefox only promises take Chrome's callback in code that calls them", async () => {
  const browser = fakeBrowser();
  const calls = [];
  browser.action = {
    openPopup: promiseOnly(calls, "action.openPopup"),
    isEnabled: promiseOnly(calls, "action.isEnabled", true),
    getBadgeTextColor: promiseOnly(calls, "action.getBadgeTextColor", [1, 2, 3, 255]),
    setBadgeTextColor: promiseOnly(calls, "action.setBadgeTextColor"),
  };
  browser.tabs = { ...browser.tabs, discard: promiseOnly(calls, "tabs.discard"), ungroup: promiseOnly(calls, "tabs.ungroup", undefined, "No group") };
  const action = browser.action;
  const code = "chrome.action.isEnabled(1, cb); chrome.action.openPopup({}, cb); chrome.tabs.ungroup([3], cb); x.getBadgeTextColor({}, cb)";
  const ctx = runInContext(buildShim({}, { "bg.js": code }), { browser });
  assert.equal(browser.action, action, "the namespace keeps its identity");
  const out = await vm.runInContext(`new Promise((resolve) => {
    const out = {};
    chrome.action.isEnabled(1, (v) => {
      out.isEnabled = v;
      chrome.action.getBadgeTextColor({ tabId: 1 }, (c) => {
        out.color = c;
        chrome.tabs.ungroup([3], () => { out.ungroup = chrome.runtime.lastError && chrome.runtime.lastError.message; resolve(out); });
      });
    });
  })`, ctx);
  assert.equal(out.isEnabled, true);
  assert.deepEqual(plain(out.color), [1, 2, 3, 255]);
  assert.equal(out.ungroup, "No group");
  assert.equal(await vm.runInContext("chrome.action.isEnabled(1)", ctx), true, "the promise form still works");
  // Methods the bundle never names stay Firefox's.
  assert.throws(() => vm.runInContext("chrome.tabs.discard(1, () => {})", ctx), /Incorrect argument types/);
});

test("a bundle naming none of them gets Firefox's methods untouched", () => {
  const browser = fakeBrowser();
  const openPopup = promiseOnly([], "action.openPopup");
  browser.action = { openPopup };
  runInContext(buildShim({}, { "bg.js": "chrome.action.setIcon({})" }), { browser });
  assert.equal(browser.action.openPopup, openPopup);
});
