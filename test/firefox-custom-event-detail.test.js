// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { buildShim } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// An isolated content script hands its world: "MAIN" script an object through a
// CustomEvent, as Enhancer for YouTube passes its preferences. Chrome clones the
// detail for the page's world; Firefox gives the page the content script's own
// object, whose every property read throws "Permission denied to access
// property". The page script reports what it read in the document title.

const ISOLATED = `
const original = { prefs: { controlbar: { active: true }, speed: 1.25 }, list: [1, 2, 3] };
let own = "unset";
document.addEventListener("t-init", (e) => { own = e.detail === original; });
document.addEventListener("t-ask", () => {
  document.dispatchEvent(new CustomEvent("t-init", { detail: original }));
  document.dispatchEvent(new CustomEvent("t-own", { detail: own }));
});
`;

const MAIN = `
let read;
document.addEventListener("t-init", (e) => {
  try { read = { json: JSON.stringify(e.detail), speed: e.detail.prefs.speed, plain: Object.getPrototypeOf(e.detail) === Object.prototype }; }
  catch (err) { read = { error: String(err) }; }
});
document.addEventListener("t-own", (e) => { document.title = JSON.stringify({ read, own: e.detail }); });
addEventListener("DOMContentLoaded", () => document.dispatchEvent(new CustomEvent("t-ask")));
`;

test("a world: \"MAIN\" script reads the object an isolated content script put in a CustomEvent's detail", { skip: !firefox && "no Firefox installed" }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>waiting</title><p>page</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/page`;

  const manifest = {
    manifest_version: 3, name: "CustomEvent detail", version: "1",
    browser_specific_settings: { gecko: { id: "custom-event-detail@lavaduct.test" } },
    content_scripts: [
      { matches: ["http://127.0.0.1/*"], js: ["main.js"], run_at: "document_start", world: "MAIN" },
      { matches: ["http://127.0.0.1/*"], js: ["lavaduct-compat-shim.js", "isolated.js"], run_at: "document_start" },
    ],
  };
  const files = { "main.js": MAIN, "isolated.js": ISOLATED };
  files["lavaduct-compat-shim.js"] = buildShim({}, files);

  const title = await loadAddon(manifest, files, async ({ chrome }) => {
    await chrome(`(() => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      globalThis.__customEventTab = win.gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      return 1;
    })()`);
    for (let i = 0; i < 150; i++) {
      const now = await chrome(`globalThis.__customEventTab.linkedBrowser.contentTitle`);
      if (now && now.startsWith("{")) return now;
      await sleep(100);
    }
    return "timed out";
  });
  assert.ok(title.startsWith("{"), title);
  const result = JSON.parse(title);
  assert.deepEqual(result.read, { json: '{"prefs":{"controlbar":{"active":true},"speed":1.25},"list":[1,2,3]}', speed: 1.25, plain: true });
  assert.equal(result.own, true, "the content script's own listener sees the object it dispatched");
});
