import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// MetaMask's content script runs LavaMoat with scuttling: after startup every
// property of globalThis outside its allow list, `console` included, becomes a
// getter that throws. The bundle keeps its own reference to console and logs
// through it. A --debug build's console.warn tee looked `console` up on the
// global at every call, so each warning threw "property console of globalThis
// is inaccessible under scuttling mode" out of MetaMask's stream code, and the
// page's window.ethereum never got an answer. A release build was fine.

const KEY = "__viaduct_debug_log__";

for (const href of ["https://example.com/", EXT_ORIGIN + "/_generated_background_page.html"]) {
  test(`a --debug tee still logs once the global console is scuttled (${href.startsWith("http") ? "content script" : "background"})`, async () => {
    const browser = fakeBrowser();
    const timers = [];
    const seen = [];
    const quiet = () => {};
    const ctx = runInContext(buildShim({ debug: true }), {
      browser, href,
      globals: {
        console: { log: quiet, info: quiet, debug: quiet, warn: (...a) => seen.push(a.join(" ")), error: quiet },
        setTimeout: (fn) => { timers.push(fn); return timers.length; },
        addEventListener: quiet,
      },
    });
    vm.runInContext(`
      var saved = console;
      Object.defineProperty(globalThis, "console", { get() { throw new Error("LavaMoat - property \\"console\\" of globalThis is inaccessible under scuttling mode"); }, configurable: true });
      saved.warn("ObjectMultiplex - orphaned data");
    `, ctx);
    assert.deepEqual(seen, ["ObjectMultiplex - orphaned data"]);
    while (timers.length) timers.shift()();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const msgs = (browser.storage.local.data[KEY] || []).map((e) => e.msg);
    assert.ok(msgs.includes("[console.warn] ObjectMultiplex - orphaned data"), msgs.join("\n"));
  });
}
