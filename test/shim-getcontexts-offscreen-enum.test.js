import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, makeLocalStorage, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";

// Firefox's runtime.ContextType has BACKGROUND, POPUP, SIDE_PANEL and TAB, so
// code that asks for its offscreen document through Chrome's enum,
// contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], passed
// [undefined] and Firefox's getContexts refused the filter.

const FIREFOX_CONTEXT_TYPES = { BACKGROUND: "BACKGROUND", POPUP: "POPUP", SIDE_PANEL: "SIDE_PANEL", TAB: "TAB" };

function browserWith(contextType) {
  const browser = fakeBrowser();
  if (contextType) browser.runtime.ContextType = { ...contextType };
  browser.runtime.getContexts = (filter) =>
    (filter?.contextTypes ?? []).every((t) => t in FIREFOX_CONTEXT_TYPES)
      ? Promise.resolve([])
      : Promise.reject(new Error(`Invalid enumeration value ${JSON.stringify(filter.contextTypes)}`));
  return browser;
}

function background(browser) {
  const body = { appendChild(f) { f.parentNode = body; }, removeChild(f) { f.parentNode = null; } };
  const document = {
    body,
    createElement: () => ({ setAttribute() {}, style: {}, addEventListener(type, fn) { if (type === "load") setTimeout(fn, 0); } }),
  };
  const shim = buildShim({}, { "bg.js": "chrome.offscreen.createDocument({ url: 'off.html' })" });
  return runInContext(shim, { browser, globals: { document, localStorage: makeLocalStorage(), setInterval: () => 0, clearInterval() {} } });
}

const ASK = "chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })";

for (const [label, contextType] of [
  ["beside Firefox's own context types", FIREFOX_CONTEXT_TYPES],
  ["where Firefox has no ContextType object", null],
]) {
  test(`chrome.runtime.ContextType.OFFSCREEN_DOCUMENT finds the offscreen document, ${label}`, async () => {
    const browser = browserWith(contextType);
    const bg = background(browser);
    await vm.runInContext("chrome.offscreen.createDocument({ url: 'off.html', reasons: ['CLIPBOARD'], justification: 'x' })", bg);

    const found = plain(await vm.runInContext(ASK, bg));
    assert.deepEqual(found.map((c) => c.documentUrl), [EXT_ORIGIN + "/off.html"]);
    if (contextType) {
      assert.equal(vm.runInContext("chrome.runtime.ContextType.TAB", bg), "TAB", "Firefox's own values stay");
    }
  });
}
