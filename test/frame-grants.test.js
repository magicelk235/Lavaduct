import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyOAuthBridge, BRIDGE_BACKGROUND, BRIDGE_PAGE, BRIDGE_PAGE_CS } from "../dist/runtime/oauth-bridge.js";
import { fakeBrowser, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Claude in Chrome's side panel frames claude.ai, which only lets
// chrome-extension://<its id> frame it. A converted add-on's pages are
// moz-extension://<uuid>: where the site's frame-ancestors lists the Chrome
// origin and the frame belongs to the add-on's own page, the add-on's origin is
// let in too, and the framed page sees its parent as the Chrome origin. Every
// other frame, and every other policy, is left alone.

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const CHROME = `chrome-extension://${CHROME_ID}`;
const OTHER_CHROME = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const SITE = "https://app.example.com";
const URL_ = `${SITE}/embed?surface=panel`;
const PANEL_PAGE = `${EXT_ORIGIN}/panel.html`;
const GRANTING = `script-src 'nonce-r4nd0m' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' ${CHROME} ${OTHER_CHROME}`;

function bridge(t) {
  const dir = mkdtempSync(join(tmpdir(), "frame-grants-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "sw.js"), "");
  writeFileSync(join(dir, "panel.js"), `const URL = ${JSON.stringify(URL_)};\nrender(h("iframe", { src: URL }));\n`);
  applyOAuthBridge(dir, {
    manifest_version: 3, name: "Panel", version: "1",
    background: { service_worker: "sw.js" },
    externally_connectable: { matches: [`${SITE}/*`] },
  }, CHROME_ID);
  const read = (f) => readFileSync(join(dir, f), "utf-8");
  return { bg: read(BRIDGE_BACKGROUND), page: read(BRIDGE_PAGE), cs: read(BRIDGE_PAGE_CS) };
}

/** The bridge's background with fake webRequest and declarativeNetRequest. */
function background(t) {
  const rules = new Map();
  const browser = fakeBrowser();
  const listen = (event) => ({ addListener(fn, filter, extra) { Object.assign(event, { fn, filter, extra }); } });
  browser.webRequest = { onHeadersReceived: {}, onErrorOccurred: {} };
  browser.webRequest.onHeadersReceived.addListener = listen(browser.webRequest.onHeadersReceived).addListener;
  browser.webRequest.onErrorOccurred.addListener = listen(browser.webRequest.onErrorOccurred).addListener;
  browser.declarativeNetRequest = {
    getSessionRules: () => Promise.resolve([...rules.values()]),
    updateSessionRules: ({ removeRuleIds = [], addRules = [] }) => {
      for (const id of removeRuleIds) rules.delete(id);
      for (const r of addRules) rules.set(r.id, plain(r));
      return Promise.resolve();
    },
  };
  runInContext(bridge(t).bg, { browser });
  const headers = browser.webRequest.onHeadersReceived;
  return { headers, rules, respond: async (details) => plain(await headers.fn(details)) };
}

function response(over = {}) {
  return {
    requestId: "7", type: "sub_frame", url: URL_, statusCode: 200, tabId: -1,
    originUrl: PANEL_PAGE, documentUrl: PANEL_PAGE, frameAncestors: [{ frameId: 0, url: PANEL_PAGE }],
    responseHeaders: [{ name: "Content-Type", value: "text/html" }, { name: "Content-Security-Policy", value: GRANTING }],
    ...over,
  };
}

test("a frame the site lets the Chrome origin embed loads again with the add-on's origin let in, and only that once", async (t) => {
  const { headers, rules, respond } = background(t);
  await tick();
  assert.deepEqual(plain(headers.filter), { urls: [`${SITE}/*`], types: ["sub_frame"] });
  assert.ok(headers.extra.includes("blocking"));

  assert.deepEqual(await respond(response()), { redirectUrl: URL_ }, "the first response is refused; the frame asks again");
  const [rule] = [...rules.values()];
  assert.deepEqual(rule.action.responseHeaders, [{
    header: "content-security-policy",
    operation: "set",
    value: `frame-ancestors 'self' ${CHROME} ${OTHER_CHROME} ${EXT_ORIGIN}; object-src 'none'; base-uri 'none'`,
  }], "the site's frame-ancestors with this add-on added, and its object-src and base-uri; no stale nonce");
  const { regexFilter, initiatorDomains, resourceTypes, tabIds } = rule.condition;
  assert.ok(new RegExp(regexFilter).test(URL_));
  assert.ok(!new RegExp(regexFilter).test(`${SITE}/embed?surface=other`), "only that URL");
  assert.deepEqual(initiatorDomains, [new URL(EXT_ORIGIN).host], "only loads this add-on starts");
  assert.deepEqual(resourceTypes, ["sub_frame"]);
  assert.deepEqual(tabIds, [-1]);

  // The second response carries the policy the rule set; the rule goes.
  const relaxed = response({ responseHeaders: [{ name: "Content-Security-Policy", value: rule.action.responseHeaders[0].value }] });
  assert.equal(await respond(relaxed), undefined);
  await tick();
  assert.equal(rules.size, 0);

  // A load where the rule didn't apply isn't sent round again.
  assert.deepEqual(await respond(response({ requestId: "8" })), { redirectUrl: URL_ });
  assert.equal(await respond(response({ requestId: "8" })), undefined);
  await tick();
  assert.equal(rules.size, 0);
});

test("every other frame and every other policy is left alone", async (t) => {
  const { rules, respond } = background(t);
  await tick();
  const web = "https://news.example/article";
  const otherAddon = "moz-extension://0d6b7c58-1f2e-4b6a-9c3d-2e1f0a9b8c7d/page.html";
  const untouched = {
    "a web page's frame": response({ originUrl: web, documentUrl: web, frameAncestors: [{ frameId: 0, url: web }] }),
    "a frame of the add-on's page inside a web page": response({ frameAncestors: [{ frameId: 0, url: PANEL_PAGE }, { frameId: 1, url: web }] }),
    "another add-on's frame": response({ originUrl: otherAddon, documentUrl: otherAddon, frameAncestors: [{ frameId: 0, url: otherAddon }] }),
    "a top-level load": response({ type: "main_frame", frameAncestors: [] }),
    "a policy that doesn't list the Chrome origin": response({ responseHeaders: [{ name: "Content-Security-Policy", value: "frame-ancestors 'self'" }] }),
    "a second policy that doesn't list it": response({ responseHeaders: [{ name: "Content-Security-Policy", value: `${GRANTING}, frame-ancestors 'self'` }] }),
    "a policy without frame-ancestors": response({ responseHeaders: [{ name: "Content-Security-Policy", value: "script-src 'self'" }] }),
    "no policy": response({ responseHeaders: [] }),
    "a redirect": response({ statusCode: 302 }),
    "a navigation the framed page starts itself": response({ originUrl: `${SITE}/embed` }),
  };
  for (const [what, details] of Object.entries(untouched)) {
    assert.equal(await respond(details), undefined, what);
  }
  await tick();
  assert.equal(rules.size, 0);
});

// The framed page's world: its own String, RegExp and MessageEvent, a parent
// it can't see into, and an ancestor list it can't change.
function pageWorld(ancestor, { top = false } = {}) {
  const posted = [];
  const parentWindow = { postMessage: (...args) => { posted.push(args); } };
  const page = vm.createContext({ console, setTimeout, clearTimeout });
  vm.runInContext(`
    var window = globalThis;
    class MessageEvent { constructor(type, init) { this._origin = init.origin; this._source = init.source; } }
    Object.defineProperty(MessageEvent.prototype, "origin", { get() { return this._origin; }, configurable: true, enumerable: true });
    Object.defineProperty(MessageEvent.prototype, "source", { get() { return this._source; }, configurable: true, enumerable: true });
    globalThis.MessageEvent = MessageEvent;
    globalThis.addEventListener = () => {};
    globalThis.dispatchEvent = () => {};
  `, page);
  Object.defineProperty(page, "parent", { get: () => (top ? page : parentWindow), configurable: true, enumerable: true });
  page.location = { href: URL_, ancestorOrigins: top ? [] : [ancestor] };
  page.realParent = parentWindow;
  return { page, posted };
}

function frame(t, ancestor, opts) {
  const { page: pageSrc, cs } = bridge(t);
  const world = pageWorld(ancestor, opts);
  // The content-script world sees the page through Firefox's wrappedJSObject.
  const browser = fakeBrowser();
  browser.runtime.connect = () => {};
  const win = { wrappedJSObject: world.page, addEventListener() {} };
  win.top = opts?.top ? win : {};
  const isolated = { console, setTimeout, clearTimeout, browser, chrome: browser, window: win, location: { href: URL_, ancestorOrigins: world.page.location.ancestorOrigins } };
  isolated.globalThis = isolated;
  vm.createContext(isolated);
  vm.runInContext(cs, isolated);
  vm.runInContext(pageSrc, world.page);
  return world;
}

test("a page framed by the add-on sees its parent as the extension's Chrome origin", (t) => {
  const { page, posted } = frame(t, EXT_ORIGIN);
  const run = (code) => vm.runInContext(code, page);
  // The check claude.ai makes on its host: location.ancestorOrigins[0] against a Chrome extension origin.
  assert.equal(run(`location.ancestorOrigins[0].match(/^chrome-extension:\\/\\/([a-p]{32})$/)[1]`), CHROME_ID);
  assert.equal(run(`/^chrome-extension:/.test(location.ancestorOrigins[0])`), true);
  assert.equal(run(`location.ancestorOrigins[0]`), EXT_ORIGIN, "the list itself can't change");
  assert.equal(run(`"moz-extension://elsewhere".match(/chrome-extension/)`), null);

  // Messages from the parent carry the Chrome origin, and come from window.parent.
  assert.equal(run(`new MessageEvent("message", { origin: ${JSON.stringify(EXT_ORIGIN)}, source: realParent }).origin`), CHROME);
  assert.equal(run(`new MessageEvent("message", { origin: ${JSON.stringify(EXT_ORIGIN)}, source: realParent }).source === window.parent`), true);
  assert.equal(run(`new MessageEvent("message", { origin: "https://news.example", source: null }).origin`), "https://news.example");

  // Posting back to the Chrome origin reaches the add-on's page.
  run(`window.parent.postMessage({ type: "auth" }, ${JSON.stringify(CHROME)})`);
  run(`window.parent.postMessage({ type: "ready" }, { targetOrigin: ${JSON.stringify(CHROME)} })`);
  run(`window.parent.postMessage({ type: "any" }, "*")`);
  assert.deepEqual(posted.map(([msg, target]) => [msg.type, plain(target)]), [
    ["auth", EXT_ORIGIN],
    ["ready", { targetOrigin: EXT_ORIGIN }],
    ["any", "*"],
  ]);
});

test("a page framed by anyone else, or not framed, sees what Firefox reports", (t) => {
  for (const [what, ancestor, opts] of [
    ["another add-on's page", "moz-extension://0d6b7c58-1f2e-4b6a-9c3d-2e1f0a9b8c7d"],
    ["a web page", "https://news.example"],
    ["no parent at all", EXT_ORIGIN, { top: true }],
  ]) {
    const { page, posted } = frame(t, ancestor, opts);
    const run = (code) => vm.runInContext(code, page);
    assert.equal(run(`String(location.ancestorOrigins[0]).match(/^chrome-extension:\\/\\/([a-p]{32})$/)`), null, what);
    assert.equal(run(`${JSON.stringify(EXT_ORIGIN)}.match(/^chrome-extension:/)`), null, what);
    assert.equal(run(`new MessageEvent("message", { origin: ${JSON.stringify(EXT_ORIGIN)}, source: null }).origin`), EXT_ORIGIN, what);
    if (!opts?.top) {
      assert.equal(run(`window.parent === realParent`), true, what);
      run(`window.parent.postMessage({ type: "auth" }, ${JSON.stringify(CHROME)})`);
      assert.deepEqual(posted.map(([, target]) => target), [CHROME], what);
    }
  }
});
