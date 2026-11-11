import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// The debug ring keeps 2000 entries in storage.local and rewrites the whole
// list on every flush. An add-on that logs a response body or a big object
// with console.error must not make each entry, and each flush, megabytes long.

const KEY = "__viaduct_debug_log__";

test("a huge console.error is stored cut down, with the length it had", async () => {
  const browser = fakeBrowser();
  const timers = [];
  const quiet = () => {};
  const console = { log: quiet, info: quiet, debug: quiet, warn: quiet, error: quiet };
  runInContext(buildShim({ debug: true }), {
    browser,
    globals: { console, setTimeout: (fn) => { timers.push(fn); return timers.length; } },
  });
  const body = "x".repeat(1_000_000);
  console.error("response:", body);
  while (timers.length) timers.shift()();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const entry = browser.storage.local.data[KEY].find((e) => e.msg.startsWith("[console.error]"));
  assert.ok(entry, "the error is logged");
  assert.ok(entry.msg.length < 5000, `entry is ${entry.msg.length} chars`);
  assert.ok(entry.msg.startsWith("[console.error] response: xxx"));
  assert.match(entry.msg, /\[\d+ more chars\]$/);
});
