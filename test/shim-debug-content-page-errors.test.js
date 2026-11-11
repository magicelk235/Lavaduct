import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// In a Firefox content script `self` is the web page's window. Its error and
// unhandledrejection events are the site's own (measured in Firefox 159: a
// page's throw and rejection reach a listener there, the content script's own
// never do), so a --debug log that teed them filled up with the site's errors
// filed under the add-on's content script.

const KEY = "__viaduct_debug_log__";

function run(href) {
  const browser = fakeBrowser();
  const timers = [];
  const listeners = {};
  const quiet = () => {};
  runInContext(buildShim({ debug: true }), {
    browser, href,
    globals: {
      console: { log: quiet, info: quiet, debug: quiet, warn: quiet, error: quiet },
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    },
  });
  const fire = (type, event) => (listeners[type] || []).forEach((fn) => fn(event));
  const entries = async () => {
    while (timers.length) timers.shift()();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return (browser.storage.local.data[KEY] || []).map((e) => e.msg);
  };
  return { fire, entries };
}

test("a content script's debug log leaves out the web page's errors", async () => {
  const cs = run("https://example.com/");
  cs.fire("error", { message: "Error: page-error", filename: "https://example.com/app.js", lineno: 1, colno: 2 });
  cs.fire("unhandledrejection", { reason: new Error("page-rejection") });
  assert.deepEqual((await cs.entries()).filter((m) => /^\[(uncaught|unhandled)/.test(m)), []);
});

test("the background's and pages' uncaught errors are still logged", async () => {
  for (const href of [EXT_ORIGIN + "/_generated_background_page.html", EXT_ORIGIN + "/popup.html"]) {
    const ctx = run(href);
    ctx.fire("error", { message: "Error: own", filename: EXT_ORIGIN + "/bg.js", lineno: 3, colno: 4 });
    ctx.fire("unhandledrejection", { reason: new Error("own-rejection") });
    const msgs = await ctx.entries();
    assert.ok(msgs.includes(`[uncaught] Error: own @${EXT_ORIGIN}/bg.js:3:4`), msgs.join("\n"));
    assert.ok(msgs.includes("[unhandled rejection] own-rejection"), msgs.join("\n"));
  }
});
