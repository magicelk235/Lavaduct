// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-content-json-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// A Firefox content script's Response is the page's, seen through an Xray, so
// json() builds its objects in the page's realm: Object.getPrototypeOf(value)
// is the page's Object.prototype, not the script's. In Chrome the isolated
// world gets its own objects. Immersive Translate merges its bundled rules
// only from objects whose prototype is Object.prototype, and in Firefox its
// content script dropped every nested rule ("[merge_rule] skipping non-plain
// object", 470 times per page).
const CONTENT = String.raw`
(async () => {
  try {
  const kind = (o) => Object.getPrototypeOf(o) === Object.prototype ? "own" : "foreign";
  const out = {};
  const fetched = await (await fetch(chrome.runtime.getURL("rules.json"))).json();
  out.fetched = kind(fetched) + "/" + kind(fetched.rule) + "/" + Array.isArray(fetched.list) + "/" + (fetched.list instanceof Array);
  out.made = kind(await new Response('{"a":{}}').json());
  try { await new Response("{nope").json(); out.invalid = "parsed"; } catch (e) { out.invalid = e.name; }
  const used = new Response("{}");
  await used.text();
  try { await used.json(); out.used = "parsed"; } catch (e) { out.used = e.name; }
  await fetch(location.origin + "/report", { method: "POST", body: JSON.stringify(out) });
  } catch (e) { await fetch(location.origin + "/report", { method: "POST", body: JSON.stringify({ error: String(e) }) }); }
})();
`;

test(
  "json() in a content script gives the script's own objects, as Chrome's isolated world does",
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
      manifest_version: 3, name: "Content JSON Probe", version: "1.0",
      host_permissions: ["http://127.0.0.1/*"],
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["cs.js"] }],
      web_accessible_resources: [{ resources: ["rules.json"], matches: ["<all_urls>"] }],
    }));
    writeFileSync(join(ext, "cs.js"), CONTENT);
    writeFileSync(join(ext, "rules.json"), JSON.stringify({ rule: { selectors: ["p"] }, list: [1] }));
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
      // A tab opened the moment the install returns can load before the content
      // script is registered, so it is reloaded until the script reports.
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
    assert.equal(probe.fetched, "own/own/true/true", "a fetched JSON file's objects are the script's own, nested ones too");
    assert.equal(probe.made, "own");
    assert.equal(probe.invalid, "SyntaxError", "invalid JSON still rejects with a SyntaxError");
    assert.equal(probe.used, "TypeError", "a body read twice still rejects with a TypeError");
  },
);
