// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildShim } from "./shim-sandbox.js";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-content-globals-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// In Chrome's isolated world `window` is the content script's global, so a
// top-level `function localize() {}` is window.localize as well. A Firefox
// content script's globals live in a sandbox whose `window` and `self` are
// Xrays to the page's window: window.localize is undefined. Liner's content
// script declares localize() and calls window.localize() while it starts, so
// it threw there and stopped before it set up anything else.
const DECLARES = String.raw`
function localize(key) { return "[" + key + "]"; }
var settings = { on: true };
async function load() { return 1; }
`;
const READS = String.raw`
(() => {
  const out = {};
  const t = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = "threw: " + e.message; } };
  t("call", () => window.localize("hi"));
  t("self", () => self.settings.on);
  t("async", () => typeof window.load);
  window.later = 5;
  t("bare", () => later);
  t("global", () => globalThis.later);
  window.settings = { on: false };
  t("reassigned", () => settings.on);
  t("native", () => typeof window.location.href);
  t("missing", () => typeof window.neverDeclared);
  t("page", () => typeof window.wrappedJSObject.localize);
  fetch(location.origin + "/report", { method: "POST", body: JSON.stringify(out) });
})();
`;

test("the names content scripts declare and read off window are collected", () => {
  const shim = buildShim({ contentScripts: ["a.js", "b.js"] }, {
    "a.js": DECLARES + "var unreadVar = 1; function onlyBare() {}",
    "b.js": READS,
    "bg.js": "function background() {} window.background();",
  });
  const config = JSON.parse(shim.match(/"contentGlobals":(\[[^\]]*\])/)[1]);
  assert.deepEqual(config.sort(), ["load", "localize", "settings"]);
});

test(
  "a content script's top-level declarations are window's properties too, as in Chrome's isolated world",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    let probe = null;
    const server = http.createServer((req, res) => {
      if (req.url === "/report") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { probe = JSON.parse(body); res.end(); });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>page</p>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const page = `http://127.0.0.1:${server.address().port}/page`;

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Content Globals Probe", version: "1.0",
      host_permissions: ["http://127.0.0.1/*"],
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["a.js", "b.js"] }],
    }));
    writeFileSync(join(ext, "a.js"), DECLARES);
    writeFileSync(join(ext, "b.js"), READS);
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    assert.ok(result.success, "the extension converts");

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      await ff.installAddon(result.stagedPath);
      for (let attempt = 0; attempt < 5 && !probe; attempt++) {
        await ff.chrome(`(() => {
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gBrowser.selectedTab = w.gBrowser.addTab(${JSON.stringify(page)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          return 1;
        })()`);
        for (let i = 0; i < 100 && !probe; i++) await sleep(100);
      }
    } finally {
      await ff.close();
    }
    assert.ok(probe, "the content script reported");
    assert.deepEqual(probe, {
      call: "[hi]", self: true, async: "function", bare: 5, global: 5, reassigned: false,
      native: "string", missing: "undefined", page: "undefined",
    });
  },
);
