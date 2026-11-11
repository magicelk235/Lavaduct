import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, makeLocalStorage, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";

// Firefox defines browser.storage only for an add-on holding the storage
// permission, and an add-on can use chrome.offscreen without it. Asking
// getContexts for its offscreen document must still answer, not throw.

function withoutStorage() {
  const browser = fakeBrowser();
  delete browser.storage;
  browser.runtime.getContexts = () => Promise.resolve([]);
  return browser;
}

function background(browser, localStorage) {
  const body = { appendChild(f) { f.parentNode = body; }, removeChild(f) { f.parentNode = null; } };
  const document = {
    body,
    createElement: () => ({ setAttribute() {}, style: {}, addEventListener(type, fn) { if (type === "load") setTimeout(fn, 0); } }),
  };
  const shim = buildShim({}, { "bg.js": "chrome.offscreen.createDocument({ url: 'off.html' })" });
  return runInContext(shim, { browser, globals: { document, localStorage, setInterval: () => 0, clearInterval() {} } });
}

const ASK = "chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })";

test("getContexts finds the offscreen document in an add-on without the storage permission", async () => {
  const browser = withoutStorage();
  const localStorage = makeLocalStorage();
  const bg = background(browser, localStorage);
  assert.deepEqual(plain(await vm.runInContext(ASK, bg)), []);
  await vm.runInContext("chrome.offscreen.createDocument({ url: 'off.html', reasons: ['CLIPBOARD'], justification: 'x' })", bg);

  const inBackground = plain(await vm.runInContext(ASK, bg));
  assert.deepEqual(inBackground.map((c) => c.documentUrl), [EXT_ORIGIN + "/off.html"]);

  const shim = buildShim({}, { "bg.js": "chrome.offscreen.createDocument({ url: 'off.html' })" });
  const popup = runInContext(shim, { browser, href: EXT_ORIGIN + "/popup.html", globals: { localStorage } });
  const inPopup = plain(await vm.runInContext(ASK, popup));
  assert.deepEqual(inPopup.map((c) => c.documentUrl), [EXT_ORIGIN + "/off.html"], "the add-on's other pages see it too");

  await vm.runInContext("chrome.offscreen.closeDocument()", bg);
  assert.deepEqual(plain(await vm.runInContext(ASK, bg)), []);
  assert.deepEqual(plain(await vm.runInContext(ASK, popup)), []);
});
