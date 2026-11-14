// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-window-builtins-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// A Firefox content script's `window` and `self` are an Xray to the page's
// window, so `self.Reflect` is the page's Reflect: `self.Object !== Object`,
// and defining a function on it throws "Not allowed to define cross-origin
// object as property on [Object] or [Array] XrayWrapper". In Chrome's isolated
// world `window.Reflect === Reflect`. reflect-metadata, which tsyringe and
// inversify load, takes `self` as its global and defines its functions on
// root.Reflect; Avast Online Security's content script died on that line on
// every page.
const REFLECT_METADATA = String.raw`
var Atomics = "mine";
(async () => {
  const out = {};
  try {
    var root = typeof global === "object" ? global : typeof self === "object" ? self : typeof this === "object" ? this : globalThis;
    if (typeof root.Reflect === "undefined") root.Reflect = {};
    Object.defineProperty(root.Reflect, "metadata", { configurable: true, writable: true, value: function metadata() {} });
    out.defined = typeof Reflect.metadata;
  } catch (e) { out.defined = String(e); }
  out.same = [self.Object === Object, window.Array === Array, window.Symbol.iterator === Symbol.iterator, self.Promise === Promise].join("/");
  out.ownName = window.Atomics;
  await fetch(location.origin + "/report/a", { method: "POST", body: JSON.stringify(out) });
})();
`;

// Code written for Firefox's Xrays builds values for the page with window's
// built-ins next to cloneInto; such a bundle keeps Firefox's window.
const FIREFOX_AWARE = String.raw`
(async () => {
  var root = typeof self === "object" ? self : globalThis;
  root.Promise.prototype.lavaductProbe = undefined;
  const fromPage = new window.Object();
  window.wrappedJSObject.fromScript = cloneInto({ a: 1 }, window);
  await fetch(location.origin + "/report/b", { method: "POST", body: JSON.stringify({ pageObject: self.Object !== Object && Object.getPrototypeOf(fromPage) !== Object.prototype }) });
})();
`;

// The page reads its own Reflect once the content scripts have run.
const PAGE = `<p>page</p><script>setTimeout(() => fetch("/report/page", { method: "POST", body: JSON.stringify({ metadata: typeof Reflect.metadata }) }), 1500);</script>`;

test(
  "a content script's window and self give its own built-ins, as Chrome's isolated world does",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const reports = {};
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/report/")) {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { reports[req.url.slice(8)] = JSON.parse(body); res.end(); });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const page = `http://127.0.0.1:${server.address().port}/page`;

    const staged = [];
    for (const [name, code] of [["a", REFLECT_METADATA], ["b", FIREFOX_AWARE]]) {
      const ext = join(scratch, "ext-" + name);
      mkdirSync(ext);
      writeFileSync(join(ext, "manifest.json"), JSON.stringify({
        manifest_version: 3, name: "Window Builtins Probe " + name, version: "1.0",
        host_permissions: ["http://127.0.0.1/*"],
        content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["cs.js"] }],
      }));
      writeFileSync(join(ext, "cs.js"), code);
      const result = await convert({
        input: ext, output: join(scratch, "out-" + name), platforms: "desktop", generateShim: true, force: false,
        sign: "auto", install: false, firefoxRestart: false, launch: false,
      });
      assert.ok(result.success, "the extension converts");
      staged.push(result.stagedPath);
    }

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      for (const dir of staged) await ff.installAddon(dir);
      // A tab opened the moment the install returns can load before the content
      // scripts are registered, so it is reloaded until all three report.
      const done = () => reports.a && reports.b && reports.page;
      for (let attempt = 0; attempt < 5 && !done(); attempt++) {
        await ff.chrome(`(() => {
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gBrowser.selectedTab = w.gBrowser.addTab(${JSON.stringify(page)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          return 1;
        })()`);
        for (let i = 0; i < 100 && !done(); i++) await sleep(100);
      }
    } finally {
      await ff.close();
    }
    assert.ok(reports.a && reports.b && reports.page, "the content scripts and the page reported");
    assert.equal(reports.a.defined, "function", "reflect-metadata's functions land on the script's own Reflect");
    assert.equal(reports.a.same, "true/true/true/true", "window and self give the script's own Object, Array, Symbol and Promise");
    assert.equal(reports.a.ownName, "mine", "the script's own global under a built-in's name, as window gives it in Chrome");
    assert.equal(reports.page.metadata, "undefined", "the page's Reflect is untouched");
    assert.equal(reports.b.pageObject, true, "a Firefox-aware bundle still builds page objects with window.Object");
  },
);
