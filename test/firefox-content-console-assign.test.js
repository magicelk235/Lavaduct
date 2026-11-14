// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-content-console-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// A Firefox content script's console is the page's, seen through an Xray, and
// the first plain assignment to one of its methods leaves an expando that is
// neither writable nor configurable: the next assignment is ignored, or throws
// "'error' is read-only" in strict code. Chrome's isolated world has a console
// of its own whose methods stay writable. Brisk Teaching wraps console.error
// with Object.assign in each of its content scripts; in Firefox the second
// script died at the top on it, and a --debug build's own console tee made
// the first one die too.
const CONTENT = (name) => String.raw`
(() => {
  "use strict";
  const out = { name: ${JSON.stringify(name)} };
  const wrap = () => { const before = console.error; Object.assign(console, { error: (...a) => before.apply(console, a) }); return console.error !== before; };
  try { out.first = wrap(); } catch (e) { out.first = String(e); }
  try { out.second = wrap(); } catch (e) { out.second = String(e); }
  try { const w = console.warn; console.warn = function () { return w.apply(console, arguments); }; console.warn = w; out.warn = console.warn === w; } catch (e) { out.warn = String(e); }
  try { console.error("still logs"); out.calls = "ok"; } catch (e) { out.calls = String(e); }
  out.pageUntouched = String(window.wrappedJSObject.console.error).includes("[native code]");
  fetch(location.origin + "/report", { method: "POST", body: JSON.stringify(out) });
})();
`;

test(
  "content scripts can wrap console methods again and again, as in Chrome's isolated world",
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

    const staged = [];
    for (const debug of [false, true]) {
      const ext = join(scratch, `ext-${debug}`);
      mkdirSync(ext);
      writeFileSync(join(ext, "manifest.json"), JSON.stringify({
        manifest_version: 3, name: `Console Probe ${debug}`, version: "1.0",
        host_permissions: ["http://127.0.0.1/*"],
        content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["cs.js"] }],
      }));
      writeFileSync(join(ext, "cs.js"), CONTENT(debug ? "debug" : "release"));
      const result = await convert({
        input: ext, output: join(scratch, `out-${debug}`), platforms: "desktop", generateShim: true, force: false,
        sign: "auto", install: false, firefoxRestart: false, launch: false, debug,
      });
      assert.ok(result.success, "the extension converts");
      staged.push(result.stagedPath);
    }

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      for (const dir of staged) await ff.installAddon(dir);
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
    for (const r of reports) {
      assert.deepEqual(r, { name: r.name, first: true, second: true, warn: true, calls: "ok", pageUntouched: true }, JSON.stringify(r));
    }
  },
);
