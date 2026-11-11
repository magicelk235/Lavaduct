import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { tick } from "./shim-sandbox.js";
import { makePage, setup, send } from "./debugger-sandbox.js";

// Runtime.enable wraps the page's console methods. A page that wraps one again
// afterwards (a logging or error-reporting library that loads late) captures
// the emulation's wrapper. Unhooking put the native method back over the
// page's wrapper, silently removing the library's instrumentation, and the
// next Runtime.enable stacked a second reporting wrapper under the page's, so
// every log arrived twice.
test("Runtime.disable leaves a console wrapper the page added later, and a new enable reports once", async () => {
  const page = makePage();
  const { bg } = setup({ page });
  const b = bg.browser;
  const logged = [];
  b.debugger.onEvent.addListener((source, method, params) => {
    if (method === "Runtime.consoleAPICalled") logged.push(params.args.map((a) => a.value).join(" "));
  });
  await b.debugger.attach({ tabId: 1 });
  await send(b, 1, "Runtime.enable");

  vm.runInContext(`
    var pageSaw = [];
    var previous = console.log;
    console.log = function () { pageSaw.push([].slice.call(arguments).join(" ")); return previous.apply(this, arguments); };
  `, page);
  await send(b, 1, "Runtime.disable");
  vm.runInContext("console.log('after disable')", page);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(pageSaw)", page)), ["after disable"], "the page's wrapper is still there");

  await send(b, 1, "Runtime.enable");
  vm.runInContext("console.log('enabled again')", page);
  await tick(80);
  assert.deepEqual(logged, ["enabled again"]);
});

test("detaching leaves a dialog wrapper the page added later, and the hook inside it answers natively", async () => {
  const page = makePage();
  const { bg } = setup({ page });
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  vm.runInContext(`
    var asked = 0;
    var previousConfirm = window.confirm;
    window.confirm = function (m) { asked++; return previousConfirm.call(this, m); };
  `, page);
  await b.debugger.detach({ tabId: 1 });
  assert.equal(vm.runInContext("window.confirm('Delete?')", page), "native confirm");
  assert.equal(vm.runInContext("asked", page), 1, "the page's wrapper is still there");
});
