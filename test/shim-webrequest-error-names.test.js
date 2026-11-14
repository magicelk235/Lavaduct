import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// Chrome reports a request an extension blocked (DNR block, webRequest cancel)
// to webRequest.onErrorOccurred as "net::ERR_BLOCKED_BY_CLIENT" and an aborted
// one as "net::ERR_ABORTED". Firefox 160 reports NS_ERROR_ABORT and
// NS_BINDING_ABORTED, so Ghostery's tracker count and AdGuard's filtering log,
// which count only "net::ERR_BLOCKED_BY_CLIENT", saw almost nothing blocked.
// The real-Firefox check is firefox-webrequest-error-names.test.js.

function firefoxErrorEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn, filter) {
      if (arguments.length > 2) throw new TypeError("Incorrect argument types for webRequest.onErrorOccurred.");
      listeners.push({ fn, filter });
    },
    removeListener(fn) { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.some((l) => l.fn === fn); },
    fire(details) { for (const l of [...listeners]) l.fn(details); },
  };
}

function setup(code) {
  const browser = fakeBrowser();
  browser.webRequest = { onErrorOccurred: firefoxErrorEvent() };
  const native = browser.webRequest.onErrorOccurred.addListener;
  const ctx = runInContext(buildShim({}, { "bg.js": code }), { browser });
  vm.runInContext(`
    globalThis.seen = [];
    globalThis.onError = (d) => seen.push(d.error);
    chrome.webRequest.onErrorOccurred.addListener(onError, { urls: ["<all_urls>"] });
  `, ctx);
  return { browser, ctx, native };
}

const BUNDLE = `chrome.webRequest.onErrorOccurred.addListener((d) => { if (d.error === "net::ERR_BLOCKED_BY_CLIENT") count++; }, { urls: ["<all_urls>"] });`;

test("an extension's block and an abort reach the listener under Chrome's names; other errors keep Firefox's", () => {
  const { browser, ctx } = setup(BUNDLE);
  const ev = browser.webRequest.onErrorOccurred;
  const firefoxDetails = { requestId: "1", url: "https://t.example/p.gif", type: "image", tabId: 3, error: "NS_ERROR_ABORT" };
  ev.fire(firefoxDetails);
  ev.fire({ requestId: "2", url: "https://a.example/", type: "xmlhttprequest", tabId: 3, error: "NS_BINDING_ABORTED" });
  ev.fire({ requestId: "3", url: "https://nx.invalid/", type: "image", tabId: 3, error: "NS_ERROR_UNKNOWN_HOST" });
  assert.deepEqual([...ctx.seen], ["net::ERR_BLOCKED_BY_CLIENT", "net::ERR_ABORTED", "NS_ERROR_UNKNOWN_HOST"]);
  assert.equal(firefoxDetails.error, "NS_ERROR_ABORT", "Firefox's details object isn't changed");
});

// identity.launchWebAuthFlow stops its window's navigation to the redirect URL
// with NS_ERROR_ABORT too (ext-identity.js), for this add-on's flow or any other
// add-on's; that is no block.
test("a stopped navigation to a Firefox identity redirect URL keeps Firefox's name", () => {
  const { browser, ctx } = setup(BUNDLE);
  const ev = browser.webRequest.onErrorOccurred;
  ev.fire({ url: "https://450e20de1877d628ea46684533fe69073b6bdb9d.extensions.allizom.org/?code=1", type: "main_frame", error: "NS_ERROR_ABORT" });
  ev.fire({ url: "http://127.0.0.1/mozoauth2/450e20de1877d628ea46684533fe69073b6bdb9d?code=1", type: "main_frame", error: "NS_ERROR_ABORT" });
  ev.fire({ url: "https://extensions.allizom.org.tracker.example/p.gif", type: "image", error: "NS_ERROR_ABORT" });
  ev.fire({ url: "http://127.0.0.1:8080/mozoauth2/x", type: "image", error: "NS_ERROR_ABORT" });
  ev.fire({ url: "https://abc.extensions.allizom.org/", type: "main_frame", error: "NS_BINDING_ABORTED" });
  assert.deepEqual([...ctx.seen], ["NS_ERROR_ABORT", "NS_ERROR_ABORT", "net::ERR_BLOCKED_BY_CLIENT", "net::ERR_BLOCKED_BY_CLIENT", "net::ERR_ABORTED"]);
});

test("the identity redirect domain is read off the add-on's own redirect URL where it has one", () => {
  const browser = fakeBrowser();
  browser.webRequest = { onErrorOccurred: firefoxErrorEvent() };
  browser.identity = { getRedirectURL: () => "https://0123abcd.redirect.example/", launchWebAuthFlow: () => Promise.resolve("") };
  const ctx = runInContext(buildShim({}, { "bg.js": BUNDLE }), { browser });
  vm.runInContext("globalThis.seen = []; chrome.webRequest.onErrorOccurred.addListener((d) => seen.push(d.error), { urls: ['<all_urls>'] });", ctx);
  browser.webRequest.onErrorOccurred.fire({ url: "https://ffff0000.redirect.example/?code=1", error: "NS_ERROR_ABORT" });
  browser.webRequest.onErrorOccurred.fire({ url: "https://ffff0000.extensions.allizom.org/?code=1", error: "NS_ERROR_ABORT" });
  assert.deepEqual([...ctx.seen], ["NS_ERROR_ABORT", "net::ERR_BLOCKED_BY_CLIENT"]);
});

test("the listener keeps every other detail, and stays removable by the add-on's function", () => {
  const { browser, ctx } = setup(BUNDLE);
  vm.runInContext("globalThis.all = []; globalThis.keep = (d) => all.push(d); chrome.webRequest.onErrorOccurred.addListener(keep, { urls: ['<all_urls>'] });", ctx);
  browser.webRequest.onErrorOccurred.fire({ requestId: "7", url: "https://t.example/", tabId: 4, frameId: 0, documentId: "d", error: "NS_ERROR_ABORT" });
  assert.deepEqual({ ...ctx.all[0] }, { requestId: "7", url: "https://t.example/", tabId: 4, frameId: 0, documentId: "d", error: "net::ERR_BLOCKED_BY_CLIENT" });
  assert.equal(vm.runInContext("chrome.webRequest.onErrorOccurred.hasListener(onError)", ctx), true);
  vm.runInContext("chrome.webRequest.onErrorOccurred.addListener(onError, { urls: ['<all_urls>'] })", ctx);
  assert.equal(browser.webRequest.onErrorOccurred.listeners.filter((l) => l.fn === browser.webRequest.onErrorOccurred.listeners[0].fn).length, 2, "the same wrapper each time, as Firefox would see the same function");
  vm.runInContext("chrome.webRequest.onErrorOccurred.removeListener(onError); chrome.webRequest.onErrorOccurred.removeListener(onError); chrome.webRequest.onErrorOccurred.removeListener(keep)", ctx);
  assert.equal(browser.webRequest.onErrorOccurred.listeners.length, 0);
  assert.equal(vm.runInContext("chrome.webRequest.onErrorOccurred.hasListener(onError)", ctx), false);
});

test("composes with the extraHeaders wrapper: a spec onErrorOccurred refuses is still left out", () => {
  const { browser, ctx } = setup(`${BUNDLE} const spec = ["extraHeaders"];`);
  vm.runInContext("globalThis.b = () => {}; chrome.webRequest.onErrorOccurred.addListener(b, { urls: ['<all_urls>'] }, ['extraHeaders']);", ctx);
  assert.equal(browser.webRequest.onErrorOccurred.listeners.length, 2);
  assert.equal(vm.runInContext("chrome.webRequest.onErrorOccurred.hasListener(b)", ctx), true);
});

test("a bundle that never names Chrome's error keeps Firefox's addListener", () => {
  const { browser, native, ctx } = setup("chrome.webRequest.onErrorOccurred.addListener((d) => console.log(d.error), { urls: ['<all_urls>'] });");
  assert.equal(browser.webRequest.onErrorOccurred.addListener, native);
  browser.webRequest.onErrorOccurred.fire({ error: "NS_ERROR_ABORT" });
  assert.deepEqual([...ctx.seen], ["NS_ERROR_ABORT"]);
});
