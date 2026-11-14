// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildShim } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// A Firefox content script's console is an Xray, and assigning one of its
// methods leaves an expando that is neither writable nor configurable: the
// first `console.log = wrapped` works, every later one throws "log is
// read-only" in strict code. Chrome's isolated world has a plain console. Error
// reporters (Bugsnag) wrap console in every bundle, and every content_scripts
// entry shares the one sandbox, so every bundle after the first died at load
// (StayFocusd's five content scripts). A debug build's console tee took the
// first assignment of warn and error itself, so even the first bundle died.

// Two bundles, each wrapping every console method the way Bugsnag does.
const wrap = (tag) => `"use strict";
{
const r = [];
for (const k of ["log", "debug", "info", "warn", "error"]) {
  try { const o = console[k]; console[k] = function () { return o.apply(this, arguments); }; r.push(k); }
  catch (e) { r.push(k + ":" + e.message); }
}
document.documentElement.setAttribute("data-${tag}", r.join(" "));
}
`;

for (const debug of [false, true]) {
  test(`every content script can wrap console's methods${debug ? " (debug build)" : ""}`, { skip: !firefox && "no Firefox installed", timeout: 180_000 }, async (t) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>waiting</title><p>page</p><script>addEventListener('load', () => setTimeout(() => { document.title = JSON.stringify({ a: document.documentElement.dataset.a, b: document.documentElement.dataset.b }); }, 200));</script>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/page`;

    const manifest = {
      manifest_version: 3, name: "console assign", version: "1",
      browser_specific_settings: { gecko: { id: "content-console-assign@lavaduct.test" } },
      content_scripts: [
        { matches: ["http://127.0.0.1/*"], js: ["lavaduct-compat-shim.js", "a.js"], run_at: "document_start" },
        { matches: ["http://127.0.0.1/*"], js: ["lavaduct-compat-shim.js", "b.js"], run_at: "document_end" },
      ],
    };
    const files = { "a.js": wrap("a"), "b.js": wrap("b") };
    files["lavaduct-compat-shim.js"] = buildShim({ debug }, files);

    const title = await loadAddon(manifest, files, async ({ chrome }) => {
      await chrome(`(() => {
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        globalThis.__consoleTab = win.gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        return 1;
      })()`);
      for (;;) {
        const state = JSON.parse(await chrome(`(async () => {
          const browser = globalThis.__consoleTab.linkedBrowser;
          const done = () => browser.currentURI.spec === ${JSON.stringify(url)} && browser.contentTitle.startsWith("{");
          for (const end = Date.now() + 20000; !done() && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
          return JSON.stringify({ done: done(), title: browser.contentTitle });
        })()`));
        if (state.done) return state.title;
      }
    });
    const result = JSON.parse(title);
    assert.equal(result.a, "log debug info warn error", "the first bundle wraps every method");
    assert.equal(result.b, "log debug info warn error", "a later bundle in the same sandbox wraps them again");
  });
}
