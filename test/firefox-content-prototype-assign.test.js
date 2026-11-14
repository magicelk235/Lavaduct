// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-content-prototype-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// A content script sees the page's DOM prototypes and window through Xrays. The
// first plain assignment to a method they own (EventTarget.prototype.addEventListener,
// XMLHttpRequest.prototype.open, window.fetch) leaves an expando that is neither
// writable nor configurable, so the next one throws `"addEventListener" is
// read-only` in strict code (measured in Firefox 160 with a probe add-on without
// lavaduct code). Chrome's isolated world has prototypes of its own that stay
// writable. Instrumentation wraps them in every content script, and twice in one
// (Sentry's fill() from both its DOM and its TryCatch integrations): Magical's
// content scripts threw 12 times on google.com.
const CONTENT = (name) => String.raw`
(() => {
  "use strict";
  // Sentry's fill(), as its bundles minify it.
  function ln(r, o, u) { if (!(o in r)) return; const c = r[o], l = u(c); typeof l == "function" && (l.__sentry_original__ = c); r[o] = l; }
  const out = { name: ${JSON.stringify(name)}, calls: [] };
  const step = (label, fn) => { try { fn(); out[label] = "ok"; } catch (e) { out[label] = String(e); } };
  ["EventTarget", "Node"].forEach((u) => {
    const c = window[u] && window[u].prototype;
    if (!c || !c.hasOwnProperty("addEventListener")) return;
    step("fillAdd", () => ln(c, "addEventListener", (orig) => function (t, f, o) { out.calls.push("add:" + t); return orig.call(this, t, f, o); }));
  });
  step("fillAddAgain", () => ln(EventTarget.prototype, "addEventListener", (orig) => function () { return orig.apply(this, arguments); }));
  step("fillOpen", () => ln(XMLHttpRequest.prototype, "open", (orig) => function () { out.calls.push("open"); return orig.apply(this, arguments); }));
  step("fillFetch", () => ln(window, "fetch", (orig) => function () { return orig.apply(this, arguments); }));
  step("protoAssign", () => { const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function () { return a.apply(this, arguments); }; });
  document.addEventListener("x-probe", () => {});
  const x = new XMLHttpRequest(); x.open("GET", location.href);
  const page = window.wrappedJSObject;
  out.pageUntouched = [page.EventTarget.prototype.addEventListener, page.XMLHttpRequest.prototype.open, page.fetch, page.Element.prototype.attachShadow]
    .every((f) => String(f).includes("[native code]"));
  out.wrapped = !!EventTarget.prototype.addEventListener.__sentry_original__;
  fetch(location.origin + "/report", { method: "POST", body: JSON.stringify(out) });
})();
`;

test(
  "content scripts can wrap DOM prototype and window methods again and again, as in Chrome's isolated world",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const reports = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/report") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { reports.push(JSON.parse(body)); res.end(); });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>page</p>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const page = `http://127.0.0.1:${server.address().port}/page`;

    // Two content scripts of one add-on, each with its own instrumentation, as bundles ship it.
    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Prototype Probe", version: "1.0",
      host_permissions: ["http://127.0.0.1/*"],
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["a.js"] }, { matches: ["http://127.0.0.1/*"], js: ["b.js"] }],
    }));
    writeFileSync(join(ext, "a.js"), CONTENT("a"));
    writeFileSync(join(ext, "b.js"), CONTENT("b"));
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false, debug: false,
    });
    assert.ok(result.success, "the extension converts");

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      await ff.installAddon(result.stagedPath);
      for (let attempt = 0; attempt < 5 && reports.length < 2; attempt++) {
        reports.length = 0;
        await ff.chrome(`(() => {
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gBrowser.selectedTab = w.gBrowser.addTab(${JSON.stringify(page)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          return 1;
        })()`);
        for (let i = 0; i < 100 && reports.length < 2; i++) await sleep(100);
      }
    } finally {
      await ff.close();
    }
    assert.equal(reports.length, 2, JSON.stringify(reports));
    for (const r of reports.sort((x, y) => x.name.localeCompare(y.name))) {
      const { calls, ...rest } = r;
      assert.deepEqual(rest, {
        name: r.name, fillAdd: "ok", fillAddAgain: "ok", fillOpen: "ok", fillFetch: "ok", protoAssign: "ok", pageUntouched: true, wrapped: true,
      }, JSON.stringify(r));
      assert.ok(calls.includes("add:x-probe") && calls.includes("open"), JSON.stringify(r));
    }
  },
);

// What the conversion reads from the bundle: the members Interface.prototype
// assignments and fill-helper calls replace, by owner; nothing for a bundle that
// replaces none.
test("the members a bundle replaces are found by owner, and a bundle that replaces none gets no fix", async () => {
  const { buildShim } = await import("./shim-sandbox.js");
  const config = (src) => JSON.parse(/try \{ CONFIG = (\{[\s\S]*?\}) \|\| \{\};/.exec(buildShim({}, { "cs.js": src }))[1]).contentPatchedMembers;
  assert.deepEqual(config(CONTENT("a")), {
    "": ["addEventListener", "fetch"], Element: ["attachShadow"], EventTarget: ["addEventListener"], XMLHttpRequest: ["open"],
  });
  // Newer Sentry releases catch the assignment, so the second wrap is lost without a word (Brisk).
  assert.deepEqual(config('function Bq(e,t,r){if(!(t in e))return;const n=e[t];if("function"!=typeof n)return;const o=r(n);try{e[t]=o}catch{}}Bq(c,"addEventListener",f);'), {
    "": ["addEventListener"],
  });
  assert.equal(config('document.addEventListener("x", f); G.prototype.clone = k; var o = { a: 1 };'), null);
});
