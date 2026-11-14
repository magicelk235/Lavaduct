// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildShim } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// A Firefox content script's `window` is an Xray to the page's window, not its
// own global. A method read off it and called without a receiver throws
// "'setTimeout' called on an object that does not implement interface Window";
// so does one called on the content script's global, which isn't a Window.
// Chrome's isolated world is a Window, and a method called without one runs on
// it. Bugsnag keeps window.setTimeout and calls it bare after wrapping it, so
// every timer of StayFocusd's content scripts threw.

const SCRIPT = `"use strict";
{
  const r = [];
  const t = (name, f) => { try { f(); r.push(name); } catch (e) { r.push(name + ":" + e.message); } };
  const [st, raf, on] = ["setTimeout", "requestAnimationFrame", "addEventListener"].map((k) => window[k]);
  // Bugsnag: wrap the window's timers, calling the kept original with this.
  for (const k of ["setTimeout", "setInterval"]) { const o = window[k]; window[k] = function () { return o.apply(this, arguments); }; }
  t("bare", () => st(() => {}, 0));
  t("raf", () => raf(() => {}));
  t("listener", () => on("x", () => {}));
  t("onGlobal", () => window.setInterval.call(globalThis, () => {}, 1000));
  t("method", () => window.setTimeout(() => {}, 0));
  t("sameTimer", () => { if (typeof st(() => {}, 0) !== "number") throw new Error("no id"); });
  document.documentElement.setAttribute("data-r", r.join(" "));
}
`;

test("a window method a content script calls without the window runs on it", { skip: !firefox && "no Firefox installed", timeout: 180_000 }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>waiting</title><p>page</p><script>addEventListener('load', () => setTimeout(() => { document.title = JSON.stringify({ r: document.documentElement.dataset.r }); }, 200));</script>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/page`;

  const manifest = {
    manifest_version: 3, name: "window method receiver", version: "1",
    browser_specific_settings: { gecko: { id: "content-window-method@lavaduct.test" } },
    content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["lavaduct-compat-shim.js", "cs.js"], run_at: "document_end" }],
  };
  const files = { "cs.js": SCRIPT };
  files["lavaduct-compat-shim.js"] = buildShim({}, files);

  const title = await loadAddon(manifest, files, async ({ chrome }) => {
    await chrome(`(() => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      globalThis.__receiverTab = win.gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      return 1;
    })()`);
    for (;;) {
      const state = JSON.parse(await chrome(`(async () => {
        const browser = globalThis.__receiverTab.linkedBrowser;
        const done = () => browser.currentURI.spec === ${JSON.stringify(url)} && browser.contentTitle.startsWith("{");
        for (const end = Date.now() + 20000; !done() && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
        return JSON.stringify({ done: done(), title: browser.contentTitle });
      })()`));
      if (state.done) return state.title;
    }
  });
  assert.equal(JSON.parse(title).r, "bare raf listener onGlobal method sameTimer");
});
