import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeBrowser, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";
import { SHIM, makePage, makeBus, extensionContext, setup, send } from "./debugger-sandbox.js";

// Firefox has no chrome.debugger; the shim emulates the DevTools protocol on
// scripting, tabs, webNavigation and webRequest. Here the "tab" is a node:vm
// context: executeScript serializes the injected function and runs it there, as
// Firefox does, and the context's eval reports a top-level `return` in Firefox's
// words.

// Claude in Chrome's javascript_tool, verbatim in logic: it evaluates `{code}` in
// REPL mode, and only when V8 reports a compile-time "Illegal return statement"
// does it run the code again wrapped in an async function.
function claudeWouldRetry(r) {
  const d = r.exceptionDetails;
  const f = d?.exception?.className !== "SyntaxError" || d?.stackTrace || d?.scriptId === undefined ? "" : d.exception.description ?? "";
  return /Illegal return statement/.test(f);
}

test("a top-level return gets V8's compile error, and the async retry it triggers returns the value", async () => {
  const { bg } = setup();
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 }, "1.3");
  const first = await send(b, 1, "Runtime.evaluate", { expression: "{return document.title\n}", returnByValue: true, awaitPromise: true, replMode: true });
  assert.equal(first.exceptionDetails.exception.className, "SyntaxError");
  assert.match(first.exceptionDetails.exception.description, /^SyntaxError: Illegal return statement/);
  assert.ok(claudeWouldRetry(first), JSON.stringify(first));

  const retry = await send(b, 1, "Runtime.evaluate", { expression: "(async()=>{\nreturn document.title\n})()", returnByValue: true, awaitPromise: true, replMode: false });
  assert.equal(retry.exceptionDetails, undefined);
  assert.deepEqual(plain(retry.result), { type: "string", value: "Test page" });
});

test("REPL mode awaits at the top level and returns the last expression", async () => {
  const { bg } = setup();
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  const value = async (expression) => {
    const r = await send(b, 1, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, replMode: true });
    assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
    return plain(r.result).value;
  };
  assert.equal(await value("{const r = await Promise.resolve(41);\nr + 1\n}"), 42);
  assert.deepEqual(await value("{await 0;\n[1, 2].map((x) => x * 2)\n}"), [2, 4]);
  // A chained call over several lines is one statement.
  assert.equal(await value("{await 0\nPromise.resolve(5)\n  .then((x) => x * 2)\n}"), 10);
  // Braces and slashes inside strings, templates and regexes don't split statements.
  assert.equal(await value("{const s = `a${'}'}b`; const re = /x}y/; await 0;\ns + re.source // trailing } comment\n}"), "a}bx}y");
  // A last statement that isn't an expression has no value.
  assert.equal(await value("{const x = await Promise.resolve(1);\n}"), undefined);
});

test("a runtime error carries a stack, so it isn't taken for a compile error", async () => {
  const { bg } = setup();
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  const r = await send(b, 1, "Runtime.evaluate", { expression: "{JSON.parse('{')\n}", returnByValue: true, awaitPromise: true, replMode: true });
  assert.equal(r.exceptionDetails.exception.className, "SyntaxError");
  assert.ok(r.exceptionDetails.stackTrace, "runtime errors have a stack trace");
  assert.equal(claudeWouldRetry(r), false);

  const rejected = await send(b, 1, "Runtime.evaluate", { expression: "Promise.reject(new RangeError('nope'))", awaitPromise: true });
  assert.equal(rejected.exceptionDetails.text, "Uncaught (in promise)");
  assert.match(rejected.exceptionDetails.exception.description, /^RangeError: nope/);
});

test("results are DevTools remote objects", async () => {
  const { bg } = setup();
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  const ev = (expression, returnByValue) => send(b, 1, "Runtime.evaluate", { expression, returnByValue });
  assert.deepEqual(plain((await ev("({ a: [1, 'x'] })", true)).result), { type: "object", value: { a: [1, "x"] } });
  assert.deepEqual(plain((await ev("null", true)).result), { type: "object", subtype: "null", value: null });
  assert.deepEqual(plain((await ev("undefined", true)).result), { type: "undefined" });
  assert.deepEqual(plain((await ev("NaN", true)).result), { type: "number", unserializableValue: "NaN", description: "NaN" });
  const handle = (await ev("[1, 2, 3]", false)).result;
  assert.equal(handle.subtype, "array");
  assert.equal(handle.description, "Array(3)");
  const props = await send(b, 1, "Runtime.getProperties", { objectId: handle.objectId, ownProperties: true });
  assert.deepEqual(props.result.filter((p) => p.name === "1").map((p) => p.value.value), [2]);
  const called = await send(b, 1, "Runtime.callFunctionOn", { objectId: handle.objectId, functionDeclaration: "function (n) { return this.length * n; }", arguments: [{ value: 10 }], returnByValue: true });
  assert.equal(called.result.value, 30);
  // A cycle can't be returned by value; V8 says so as a protocol error.
  await assert.rejects(ev("(() => { const o = {}; o.o = o; return o; })()", true), /Object reference chain is too long/);
});

test("a screenshot clip becomes a captureTab rectangle at the page's device pixel ratio", async () => {
  const { bg, captures } = setup({ page: makePage({ devicePixelRatio: 2 }), zoom: 1.25 });
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  const shot = await send(b, 1, "Page.captureScreenshot", { format: "jpeg", quality: 60, clip: { x: 10, y: 20, width: 300, height: 200, scale: 0.5 } });
  assert.equal(shot.data, "QUJD");
  // 300 CSS px × 2 device px × clip scale 0.5 = 300 px; captureTab multiplies by the zoom itself.
  assert.deepEqual(captures[0], { tabId: 1, opts: { format: "jpeg", quality: 60, rect: { x: 10, y: 20, width: 300, height: 200 }, scale: 0.8 } });

  await send(b, 1, "Page.captureScreenshot", {});
  assert.deepEqual(captures[1].opts, { format: "png", scale: 1.6 }, "the viewport, in device pixels");
  await assert.rejects(send(b, 1, "Page.captureScreenshot", { clip: { x: 0, y: 0, width: 0, height: 10 } }), /Invalid clip/);
});

test("callback callers get runtime.lastError with Chrome's messages, and it is cleared afterwards", async () => {
  const { bg } = setup();
  const b = bg.browser;
  const viaCallback = (fn) => new Promise((resolve) => fn((result) => resolve({ result: plain(result), error: b.runtime.lastError ? b.runtime.lastError.message : undefined })));

  const notAttached = await viaCallback((cb) => b.debugger.sendCommand({ tabId: 1 }, "Page.enable", {}, cb));
  assert.deepEqual(notAttached, { result: undefined, error: "Debugger is not attached to the tab with id: 1." });
  assert.equal(b.runtime.lastError, null, "lastError only lives during the callback");

  const missing = await viaCallback((cb) => b.debugger.attach({ tabId: 77 }, "1.3", cb));
  assert.equal(missing.error, "No tab with given id 77.");

  await b.debugger.attach({ tabId: 1 }, "1.3");
  const twice = await viaCallback((cb) => b.debugger.attach({ tabId: 1 }, "1.3", cb));
  assert.equal(twice.error, "Another debugger is already attached to the tab with id: 1.");
  const unknown = await viaCallback((cb) => b.debugger.sendCommand({ tabId: 1 }, "Foo.bar", {}, cb));
  assert.equal(unknown.error, `{"code":-32601,"message":"'Foo.bar' wasn't found"}`);
  const fine = await viaCallback((cb) => b.debugger.sendCommand({ tabId: 1 }, "Page.enable", cb));
  assert.deepEqual(fine, { result: {}, error: undefined });
});

test("pages the add-on can't script refuse an attach", async () => {
  const { bg } = setup({ tabs: { 1: { url: "about:preferences" }, 2: { url: "https://addons.mozilla.org/en-US/firefox/" } } });
  await assert.rejects(bg.browser.debugger.attach({ tabId: 1 }), /^Error: Cannot attach to this target/);
  await assert.rejects(bg.browser.debugger.attach({ tabId: 2 }), /^Error: Cannot attach to this target/);
});

test("navigation, console, dialog and network events reach onEvent listeners", async () => {
  const { bg } = setup();
  const b = bg.browser;
  const events = [];
  b.debugger.onEvent.addListener((source, method, params) => events.push({ source: plain(source), method, params: plain(params) }));
  await b.debugger.attach({ tabId: 1 });
  await send(b, 1, "Page.enable");
  await send(b, 1, "Runtime.enable");
  await send(b, 1, "Network.enable", { maxPostDataSize: 4 });

  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, parentFrameId: -1, url: "https://example.test/next", timeStamp: 1000 });
  b.webNavigation.onCommitted.fire({ tabId: 2, frameId: 0, parentFrameId: -1, url: "https://other.test/", timeStamp: 1000 });
  const report = (reports) => b.runtime.onMessage.listeners.forEach((fn) => fn({ __cdpEmulation: "report", reports }, { tab: { id: 1 }, frameId: 0 }, () => {}));
  report([{ kind: "console", type: "log", args: [{ type: "string", value: "hi" }], t: 5, frames: [] }]);
  report([{ kind: "dialog", type: "confirm", message: "Sure?", url: "https://example.test/next" }]);
  b.webRequest.onBeforeRequest.fire({ requestId: "7", tabId: 1, frameId: 0, method: "POST", type: "xmlhttprequest", url: "https://example.test/api", timeStamp: 2000, requestBody: { formData: { q: ["hello"] } } });
  b.webRequest.onResponseStarted.fire({ requestId: "7", tabId: 1, frameId: 0, url: "https://example.test/api", statusCode: 201, statusLine: "HTTP/2 201 Created", responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }], timeStamp: 2100 });
  b.webRequest.onCompleted.fire({ requestId: "7", tabId: 1, frameId: 0, url: "https://example.test/api", statusCode: 201, timeStamp: 2200 });
  await tick(5);

  const byMethod = (m) => events.filter((e) => e.method === m);
  const [navigated] = byMethod("Page.frameNavigated");
  assert.deepEqual(navigated.source, { tabId: 1 }, "only the attached tab reports");
  assert.equal(navigated.params.frame.url, "https://example.test/next");
  assert.equal(navigated.params.frame.parentId, undefined, "the top frame has no parent");
  assert.equal(byMethod("Page.frameNavigated").length, 1);
  assert.deepEqual(byMethod("Runtime.consoleAPICalled")[0].params.args, [{ type: "string", value: "hi" }]);
  assert.equal(byMethod("Page.javascriptDialogOpening")[0].params.type, "confirm");
  const [request] = byMethod("Network.requestWillBeSent");
  assert.equal(request.params.request.method, "POST");
  assert.equal(request.params.request.postData, "q=he", "cut at maxPostDataSize");
  assert.equal(request.params.type, "XHR");
  const [response] = byMethod("Network.responseReceived");
  assert.equal(response.params.requestId, "7");
  assert.equal(response.params.response.status, 201);
  assert.equal(response.params.response.mimeType, "application/json");
  assert.equal(byMethod("Network.loadingFinished").length, 1);

  // The dialog was answered in the page already; handling it closes it.
  assert.deepEqual(plain(await send(b, 1, "Page.handleJavaScriptDialog", { accept: true })), {});
  assert.equal(byMethod("Page.javascriptDialogClosed").length, 1);
  await assert.rejects(send(b, 1, "Page.handleJavaScriptDialog", { accept: true }), /No dialog is showing/);
});

test("closing the tab detaches it with target_closed, a deliberate detach doesn't", async () => {
  const { bg } = setup({ tabs: { 1: { url: "https://example.test/" }, 2: { url: "https://example.test/" } } });
  const b = bg.browser;
  const detached = [];
  b.debugger.onDetach.addListener((source, reason) => detached.push([plain(source), reason]));
  await b.debugger.attach({ tabId: 1 });
  await b.debugger.attach({ tabId: 2 });
  await b.debugger.detach({ tabId: 2 });
  b.tabs.onRemoved.fire(1, {});
  assert.deepEqual(detached, [[{ tabId: 1 }, "target_closed"]]);
  await assert.rejects(send(b, 1, "Page.enable"), /Debugger is not attached to the tab with id: 1/);
  const targets = plain(await b.debugger.getTargets());
  assert.deepEqual(targets.map((t) => [t.tabId, t.attached]), [[1, false], [2, false]]);
});

test("a side panel drives the background's sessions and hears their events", async () => {
  const { bus, bg, page, tabs } = setup();
  const panel = extensionContext(bus, { href: EXT_ORIGIN + "/sidepanel.html", tabs, page });
  const seen = [];
  panel.browser.debugger.onEvent.addListener((source, method) => seen.push([plain(source), method]));
  // The add-on's own listeners never see the emulation's messages.
  const ownMessages = [];
  bg.browser.runtime.onMessage.addListener((m) => { ownMessages.push(m); });

  await panel.browser.debugger.attach({ tabId: 1 }, "1.3");
  const targets = plain(await bg.browser.debugger.getTargets());
  assert.equal(targets.find((t) => t.tabId === 1).attached, true, "the background owns the session the panel opened");
  await assert.rejects(bg.browser.debugger.attach({ tabId: 1 }), /Another debugger is already attached/);

  const title = await panel.browser.debugger.sendCommand({ tabId: 1 }, "Runtime.evaluate", { expression: "document.title", returnByValue: true });
  assert.equal(plain(title.result).value, "Test page");
  await panel.browser.debugger.sendCommand({ tabId: 1 }, "Page.enable");
  bg.browser.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, parentFrameId: -1, url: "https://example.test/x", timeStamp: 1 });
  await tick(5);
  assert.deepEqual(seen, [[{ tabId: 1 }, "Page.frameNavigated"]]);
  assert.deepEqual(ownMessages, []);
  await panel.browser.runtime.sendMessage({ type: "hello" });
  assert.deepEqual(plain(ownMessages), [{ type: "hello" }]);
});

test("sessions survive the event page being suspended", async () => {
  const { bg, page, tabs } = setup();
  await bg.browser.debugger.attach({ tabId: 1 });
  await send(bg.browser, 1, "Page.enable");
  // A new background on the same storage.session, as after a restart.
  const fresh = extensionContext(makeBus(), {
    href: EXT_ORIGIN + "/_generated_background_page.html", tabs, page, session: bg.browser.storage.session,
  });
  const targets = plain(await fresh.browser.debugger.getTargets());
  assert.equal(targets.find((t) => t.tabId === 1).attached, true);
  await assert.rejects(fresh.browser.debugger.attach({ tabId: 1 }), /Another debugger is already attached/);
});

test("content scripts get no chrome.debugger", () => {
  const browser = fakeBrowser();
  runInContext(SHIM, { browser, href: "https://example.test/" });
  assert.equal(browser.debugger, undefined);
});
