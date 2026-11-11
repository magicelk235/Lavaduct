import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, makeEvent, runInContext, plain, tick } from "./shim-sandbox.js";

// Chrome sends extension messages as JSON: a URL becomes its string, a
// function is dropped. Firefox structured-clones them and fails on both
// (measured in Firefox 159):
//   - runtime.sendMessage / tabs.sendMessage reject with a DataCloneError, or
//     call the callback with lastError "URL object could not be cloned.";
//   - Port.postMessage throws the DataCloneError;
//   - sendResponse, or a listener's promise, with such a value throws nothing,
//     and the sender is told "Receiving end does not exist."
// Speechify's background sends a URL with tabs.sendMessage. Firefox's own
// clone is kept for whatever it can clone; only what it can't goes as JSON.

function cloneError(what = "URL") {
  const e = new Error(`${what} object could not be cloned.`);
  e.name = "DataCloneError";
  return e;
}

// Firefox's checks, as structuredClone makes them.
function firefoxClone(value) {
  try { return structuredClone(value); } catch { throw cloneError(value && typeof value === "object" && Object.values(value).some((v) => typeof v === "function") ? "Function" : "URL"); }
}

function setup(code = "chrome.runtime.sendMessage({ type: 'hello' });") {
  const browser = fakeBrowser();
  const sent = [];
  browser.runtime.sendMessage = (...args) => {
    const cb = typeof args.at(-1) === "function" ? args.pop() : null;
    try { firefoxClone(args.at(-1)); } catch (e) {
      if (!cb) return Promise.reject(e);
      // Firefox calls back later, with lastError set only while the callback runs.
      queueMicrotask(() => {
        browser.runtime.nativeLastError = { message: e.message };
        cb();
        browser.runtime.nativeLastError = null;
      });
      return undefined;
    }
    sent.push(["runtime", ...args]);
    if (cb) { queueMicrotask(() => cb("reply")); return undefined; }
    return Promise.resolve("reply");
  };
  browser.tabs.sendMessage = (tabId, message) => {
    try { firefoxClone(message); } catch (e) { return Promise.reject(e); }
    sent.push(["tabs", tabId, message]);
    return Promise.resolve("reply");
  };
  const posted = [];
  const makePort = () => ({ name: "p", postMessage(m) { firefoxClone(m); posted.push(m); }, onMessage: makeEvent(), disconnect() {} });
  browser.runtime.connect = () => makePort();
  browser.runtime.onConnect = makeEvent();
  const nativeSend = browser.runtime.sendMessage;
  const ctx = runInContext(buildShim({}, { "bg.js": code }), { browser });
  return { browser, ctx, sent, posted, makePort, nativeSend };
}

test("a bundle that never messages keeps Firefox's sendMessage", () => {
  const { browser, nativeSend } = setup("chrome.storage.local.get('x');");
  assert.equal(browser.runtime.sendMessage, nativeSend);
});

test("sendMessage with a value Firefox can't clone goes as JSON, as Chrome sends it", async () => {
  const { ctx, sent } = setup();
  const reply = await vm.runInContext("chrome.runtime.sendMessage({ u: new URL('http://a.test/x'), f() {}, n: 1 })", ctx);
  assert.equal(reply, "reply");
  assert.deepEqual(plain(sent[0]), ["runtime", { u: "http://a.test/x", n: 1 }]);
  await vm.runInContext("chrome.tabs.sendMessage(7, { u: new URL('http://b.test/') })", ctx);
  assert.deepEqual(plain(sent[1]), ["tabs", 7, { u: "http://b.test/" }]);

  const viaCallback = await new Promise((resolve) => {
    ctx.done = (r) => resolve({ r, lastError: ctx.chrome.runtime.lastError });
    vm.runInContext("chrome.runtime.sendMessage({ u: new URL('http://c.test/') }, done)", ctx);
  });
  assert.deepEqual(viaCallback, { r: "reply", lastError: null }, "the callback hears the answer, not the clone error");
  assert.deepEqual(plain(sent[2]), ["runtime", { u: "http://c.test/" }]);
});

test("what Firefox can clone keeps Firefox's own clone", async () => {
  const { ctx, sent } = setup();
  await vm.runInContext("globalThis.msg = { m: new Map([[1, 2]]), d: new Date(0) }; chrome.runtime.sendMessage(msg)", ctx);
  assert.equal(sent[0][1], ctx.msg, "the add-on's own object reaches Firefox");
  await assert.rejects(vm.runInContext("const c = {}; c.self = c; c.f = () => {}; chrome.runtime.sendMessage(c)", ctx), /could not be cloned/, "no JSON either: Firefox's error stands");
});

test("Port.postMessage falls back to JSON, on ports from connect and onConnect alike", async () => {
  const { browser, ctx, posted, makePort } = setup();
  const port = vm.runInContext("globalThis.port = chrome.runtime.connect({ name: 'p' }); port.postMessage({ u: new URL('http://a.test/') }); port", ctx);
  assert.equal(ctx.port, port);
  assert.deepEqual(plain(posted[0]), { u: "http://a.test/" });

  vm.runInContext("globalThis.onConnect = (p) => { p.postMessage({ u: new URL('http://d.test/') }); }; chrome.runtime.onConnect.addListener(onConnect);", ctx);
  browser.runtime.onConnect.fire(makePort());
  assert.deepEqual(plain(posted[1]), { u: "http://d.test/" });
  assert.equal(vm.runInContext("chrome.runtime.onConnect.hasListener(onConnect)", ctx), true);
  vm.runInContext("chrome.runtime.onConnect.removeListener(onConnect)", ctx);
  assert.equal(browser.runtime.onConnect.listeners.length, 0);
});

test("sendResponse and a listener's promise answer with JSON when Firefox can't clone the answer", async () => {
  const { browser, ctx } = setup();
  vm.runInContext(`
    globalThis.viaSend = (m, sender, sendResponse) => { if (m === "send") sendResponse({ u: new URL("http://a.test/"), keep: new Map([[1, 2]]).size }); };
    globalThis.viaPromise = (m) => (m === "promise" ? Promise.resolve({ u: new URL("http://b.test/"), f() {} }) : undefined);
    globalThis.keepsTrue = () => true;
    chrome.runtime.onMessage.addListener(viaSend);
    chrome.runtime.onMessage.addListener(viaPromise);
    chrome.runtime.onMessage.addListener(keepsTrue);
  `, ctx);
  const answers = [];
  const results = browser.runtime.onMessage.fire("send", {}, (r) => answers.push(r));
  assert.deepEqual(plain(answers[0]), { u: "http://a.test/", keep: 1 });
  assert.equal(results[2], true, "a listener returning true still keeps the channel open");
  const fromPromise = await browser.runtime.onMessage.fire("promise", {}, () => {})[1];
  assert.deepEqual(plain(fromPromise), { u: "http://b.test/" });
  const cloneable = { a: new Map() };
  vm.runInContext("chrome.runtime.onMessage.removeListener(viaSend)", ctx);
  assert.equal(vm.runInContext("chrome.runtime.onMessage.hasListener(viaSend)", ctx), false);
  ctx.cloneable = cloneable;
  vm.runInContext("chrome.runtime.onMessage.addListener((m, s, send) => { if (m === 'c') send(cloneable); })", ctx);
  const got = [];
  browser.runtime.onMessage.fire("c", {}, (r) => got.push(r));
  assert.equal(got[0], cloneable, "an answer Firefox can clone is passed as it is");
  await tick();
});
