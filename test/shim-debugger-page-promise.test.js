import { test } from "node:test";
import assert from "node:assert/strict";
import { plain } from "./shim-sandbox.js";
import { makePage, setup, send } from "./debugger-sandbox.js";

// Angular's zone.js, and older promise polyfills, replace window.Promise with
// their own class. Firefox's scripting.executeScript awaits a result only when
// it is a native promise; any other thenable is structured-cloned as it is,
// which fails ("result is non-structured-clonable data"). So an awaited
// evaluation must hand Firefox a native promise whatever the page did to
// window.Promise.
const ZONE_LIKE = `
  (function () {
    var Native = window.Promise;
    function ZonePromise(executor) { this._p = new Native(executor); }
    function wrap(p) { var z = Object.create(ZonePromise.prototype); z._p = p; return z; }
    ZonePromise.prototype.then = function (a, b) { return wrap(this._p.then(a, b)); };
    ZonePromise.prototype.catch = function (b) { return this.then(undefined, b); };
    ZonePromise.resolve = function (v) { return wrap(Native.resolve(v)); };
    ZonePromise.reject = function (v) { return wrap(Native.reject(v)); };
    window.Promise = ZonePromise;
  })();
`;

test("awaited evaluations work on a page that replaced window.Promise", async () => {
  const { bg } = setup({ page: makePage({ title: "Zone page", script: ZONE_LIKE }) });
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  const evaluate = (expression, extra) => send(b, 1, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...extra });

  const fromPagePromise = await evaluate("new Promise((resolve) => setTimeout(() => resolve(7), 5))");
  assert.deepEqual(plain(fromPagePromise.result), { type: "number", value: 7, description: "7" });

  const repl = await evaluate("{const n = await 20;\nn * 2\n}", { replMode: true });
  assert.equal(plain(repl.result).value, 40);

  const asyncFn = await evaluate("(async () => {\nreturn document.title\n})()");
  assert.deepEqual(plain(asyncFn.result), { type: "string", value: "Zone page" });

  const rejected = await evaluate("Promise.reject(new RangeError('nope'))");
  assert.equal(rejected.exceptionDetails.text, "Uncaught (in promise)");
  assert.match(rejected.exceptionDetails.exception.description, /^RangeError: nope/);

  const handle = (await send(b, 1, "Runtime.evaluate", { expression: "Promise.resolve(3)" })).result;
  const awaited = await send(b, 1, "Runtime.awaitPromise", { promiseObjectId: handle.objectId, returnByValue: true });
  assert.equal(plain(awaited.result).value, 3);
});
