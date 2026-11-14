import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain } from "./shim-sandbox.js";

// Firefox resolves a relative path in executeScript, insertCSS/removeCSS and
// registered content scripts against the page making the call, Chrome from the
// extension root. Measured on Firefox 160 from an html/ page: files: ["inject.js"]
// ran html/inject.js, insertCSS("s.css") failed, registerContentScripts stored
// "html/reg.js". Loom injects from its html/ pages, and even the shim put first
// failed there as html/lavaduct-compat-shim.js. The live check is
// firefox-injected-paths-from-subfolder.test.js.

function background(bundle) {
  const browser = fakeBrowser();
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, plain(args)]); return Promise.resolve([]); };
  browser.scripting = {
    executeScript: rec("executeScript"),
    insertCSS: rec("insertCSS"),
    removeCSS: rec("removeCSS"),
    registerContentScripts: rec("registerContentScripts"),
    updateContentScripts: rec("updateContentScripts"),
  };
  browser.tabs.insertCSS = rec("tabs.insertCSS");
  browser.tabs.removeCSS = rec("tabs.removeCSS");
  const original = { insertCSS: browser.scripting.insertCSS, executeScript: browser.scripting.executeScript, tabsInsertCSS: browser.tabs.insertCSS };
  const ctx = runInContext(buildShim({}, { "bg.js": bundle }), { browser });
  return { ctx, calls, browser, original };
}

test("relative stylesheet paths are rooted; absolute paths and URLs are left alone", async () => {
  const { ctx, calls } = background('chrome.scripting.insertCSS({ target, files: ["a.css"] })');
  const files = '["a.css", "./x/b.css", "/c.css", "https://example.com/d.css", "moz-extension://u/e.css"]';
  await vm.runInContext(`chrome.scripting.insertCSS({ target: { tabId: 1 }, files: ${files} })`, ctx);
  await vm.runInContext(`chrome.scripting.removeCSS({ target: { tabId: 1 }, files: ${files} })`, ctx);
  const rooted = ["/a.css", "/./x/b.css", "/c.css", "https://example.com/d.css", "moz-extension://u/e.css"];
  assert.deepEqual(calls.map((c) => [c[0], c[1][0].files]), [["insertCSS", rooted], ["removeCSS", rooted]]);
  await vm.runInContext('chrome.scripting.insertCSS({ target: { tabId: 1 }, css: "p{}" })', ctx);
  assert.deepEqual(calls[2][1][0], { target: { tabId: 1 }, css: "p{}" }, "inline CSS is passed through");
});

test("a bundle that only inserts CSS gets its injected scripts rooted but no shim put first", async () => {
  const { ctx, calls } = background('chrome.scripting.insertCSS({ target, files: ["a.css"] })');
  await vm.runInContext('chrome.scripting.executeScript({ target: { tabId: 1 }, files: ["inject.js"] })', ctx);
  await vm.runInContext('chrome.scripting.registerContentScripts([{ id: "a", js: ["a.js"], css: ["a.css"], matches: ["<all_urls>"] }])', ctx);
  assert.deepEqual(calls[0][1][0].files, ["/inject.js"]);
  assert.deepEqual([calls[1][1][0][0].js, calls[1][1][0][0].css], [["/a.js"], ["/a.css"]]);
});

test("MV2 tabs.insertCSS and removeCSS root their file, with or without a tab ID", async () => {
  const { ctx, calls } = background('chrome.tabs.insertCSS(1, { file: "a.css" })');
  await vm.runInContext('chrome.tabs.insertCSS(1, { file: "a.css", allFrames: true })', ctx);
  await vm.runInContext('chrome.tabs.removeCSS({ file: "css/a.css" })', ctx);
  await vm.runInContext('chrome.tabs.insertCSS(1, { code: "p{}" })', ctx);
  assert.deepEqual(plain(calls), [
    ["tabs.insertCSS", [1, { file: "/a.css", allFrames: true }]],
    ["tabs.removeCSS", [{ file: "/css/a.css" }]],
    ["tabs.insertCSS", [1, { code: "p{}" }]],
  ]);
});

test("a bundle that injects and inserts nothing keeps Firefox's methods", () => {
  const { browser, original } = background("chrome.runtime.sendMessage(1)");
  assert.equal(browser.scripting.insertCSS, original.insertCSS);
  assert.equal(browser.scripting.executeScript, original.executeScript);
  assert.equal(browser.tabs.insertCSS, original.tabsInsertCSS);
});
