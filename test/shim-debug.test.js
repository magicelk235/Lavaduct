import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// --debug builds the shim with a ring buffer that keeps the last entries in
// storage.local under __viaduct_debug_log__, where --logs reads them back.

const KEY = "__viaduct_debug_log__";

function run({ debug, href }) {
  const browser = fakeBrowser();
  const timers = [];
  const quiet = () => {};
  const console = { log: quiet, info: quiet, debug: quiet, warn: quiet, error: quiet };
  const originalError = console.error;
  runInContext(buildShim({ debug }), {
    browser, href,
    globals: { console, setTimeout: (fn) => { timers.push(fn); return timers.length; } },
  });
  const flush = async () => {
    while (timers.length) timers.shift()();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { browser, console, originalError, flush };
}

test("a --debug build persists console errors with their context", async () => {
  const bg = run({ debug: true });
  bg.console.error("boom", { code: 7 });
  await bg.flush();
  const consoleEntries = (b) => (b.storage.local.data[KEY] || []).filter((e) => e.msg.startsWith("[console."));
  const log = consoleEntries(bg.browser);
  assert.equal(log.length, 1);
  assert.equal(log[0].ctx, "background");
  assert.equal(log[0].msg, '[console.error] boom {"code":7}');
  assert.equal(typeof log[0].t, "number");

  const popup = run({ debug: true, href: EXT_ORIGIN + "/popup.html" });
  popup.console.warn("careful");
  await popup.flush();
  assert.equal(consoleEntries(popup.browser)[0].ctx, "page");

  const content = run({ debug: true, href: "https://example.com/" });
  content.console.error("cs");
  await content.flush();
  assert.equal(consoleEntries(content.browser)[0].ctx, "content");
});

test("a release build logs nothing and leaves console alone", async () => {
  const bg = run({ debug: false });
  assert.equal(bg.console.error, bg.originalError);
  bg.console.error("boom");
  await bg.flush();
  assert.equal(bg.browser.storage.local.data[KEY], undefined);
});
