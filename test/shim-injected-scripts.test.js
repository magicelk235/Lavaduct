import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain, tick } from "./shim-sandbox.js";

// The conversion puts the shim first in every manifest content script, but a
// file injected at runtime into a tab no manifest script matched ran without
// it (measured on Firefox 160: window.chrome undefined there). 17 of the 24
// corpus extensions inject files with scripting.executeScript.

const SHIM = "lavaduct-compat-shim.js";
const BUNDLE = { "bg.js": 'chrome.scripting.executeScript({ target: { tabId }, files: ["inject.js"] })' };

function background(files = BUNDLE) {
  const browser = fakeBrowser();
  const calls = browser.calls;
  browser.scripting = {
    executeScript: (d) => { calls.push(["executeScript", d]); return Promise.resolve([{ result: 1 }]); },
    registerContentScripts: (s) => { calls.push(["registerContentScripts", s]); return Promise.resolve(); },
    updateContentScripts: (s) => { calls.push(["updateContentScripts", s]); return Promise.resolve(); },
    getRegisteredContentScripts: () => Promise.resolve([{ id: "a", js: [SHIM, "a.js"], matches: ["<all_urls>"] }, { id: "m", js: ["m.js"], world: "MAIN" }]),
  };
  const ctx = runInContext(buildShim({}, files), { browser });
  return { ctx, calls, browser };
}

test("files injected into the isolated world get the shim first", async () => {
  const { ctx, calls } = background();
  const res = await vm.runInContext('chrome.scripting.executeScript({ target: { tabId: 1 }, files: ["inject.js"] })', ctx);
  assert.deepEqual(plain(res), [{ result: 1 }], "the injected file's result comes back as before");
  await vm.runInContext('chrome.scripting.executeScript({ target: { tabId: 1 }, files: ["/lavaduct-compat-shim.js", "b.js"] })', ctx);
  await vm.runInContext('chrome.scripting.executeScript({ target: { tabId: 1 }, files: ["page.js"], world: "MAIN" })', ctx);
  await vm.runInContext("chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => 1 })", ctx);
  // Relative paths are rooted, as Chrome resolves them (shim-injected-paths-from-root).
  assert.deepEqual(plain(calls.map((c) => c[1].files ?? "func")), [["/" + SHIM, "/inject.js"], ["/lavaduct-compat-shim.js", "/b.js"], ["/page.js"], "func"]);
});

test("registered content scripts get it too, and getRegisteredContentScripts leaves it out", async () => {
  const { ctx, calls } = background({ "bg.js": "chrome.scripting.registerContentScripts(s)" });
  await vm.runInContext('chrome.scripting.registerContentScripts([{ id: "a", js: ["a.js"], matches: ["<all_urls>"] }, { id: "m", js: ["m.js"], world: "MAIN", matches: ["<all_urls>"] }, { id: "c", css: ["c.css"], matches: ["<all_urls>"] }])', ctx);
  await vm.runInContext('chrome.scripting.updateContentScripts([{ id: "a", js: ["a2.js"] }])', ctx);
  assert.deepEqual(Array.from(calls[0][1], (s) => (s.js ? [...s.js] : s.js)), [["/" + SHIM, "/a.js"], ["/m.js"], undefined]);
  assert.deepEqual(plain(calls[1][1][0].js), ["/" + SHIM, "/a2.js"]);
  const listed = plain(await vm.runInContext("chrome.scripting.getRegisteredContentScripts()", ctx));
  assert.deepEqual(listed.map((s) => s.js), [["a.js"], ["m.js"]]);
  vm.runInContext("chrome.scripting.getRegisteredContentScripts((l) => { globalThis.cbList = l; })", ctx);
  await tick(5);
  assert.deepEqual(plain(ctx.cbList[0].js), ["a.js"]);
});

test("MV2 tabs.executeScript injects the shim in a call of its own first", async () => {
  const browser = fakeBrowser();
  const order = [];
  browser.tabs.executeScript = (...args) => { order.push(plain(args)); return Promise.resolve(["r"]); };
  const ctx = runInContext(buildShim({}, { "bg.js": 'chrome.tabs.executeScript(1, { file: "x.js" })' }), { browser });
  const res = await vm.runInContext('chrome.tabs.executeScript(1, { file: "x.js", allFrames: true })', ctx);
  assert.deepEqual(plain(res), ["r"]);
  assert.deepEqual(order, [[1, { file: "/" + SHIM, allFrames: true }], [1, { file: "/x.js", allFrames: true }]]);
});

test("a bundle that injects nothing keeps Firefox's methods", () => {
  const { browser } = background({ "bg.js": "chrome.runtime.sendMessage(1)" });
  assert.equal(browser.scripting.executeScript.name, "executeScript");
});
