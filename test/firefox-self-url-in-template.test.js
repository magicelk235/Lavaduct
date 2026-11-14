// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { applySourceRewrites } from "../dist/input/stage.js";
import { firefox, loadAddon } from "./firefox-load.js";

// Loom's and Monica's content scripts put their own files in the page through URLs
// built inside larger templates, `<img src="chrome-extension://${chrome.runtime.id}/…">`,
// or with the host held in a variable. Firefox has no chrome-extension: scheme and its
// runtime.id is the gecko ID, so every such image, font and frame failed to load. The
// conversion now checks the host when the URL is built; this runs that code in
// Firefox's content-script world, where it has to find the extension API itself.

const CONTENT = `
const id = chrome.runtime.id;
const other = "dahenjhkoodjbpjheillcadbppiidmhp";
const box = document.createElement("div");
box.innerHTML = \`<img id="inline" src="chrome-extension://\${chrome.runtime.id}/i.png"><img id="alias" src="chrome-extension://\${id}/i.png">\`;
document.body.append(box);
const loaded = (img) => new Promise((resolve) => {
  img.onload = () => resolve("load");
  img.onerror = () => resolve("error");
});
Promise.all([loaded(box.querySelector("#inline")), loaded(box.querySelector("#alias"))]).then(([inline, alias]) => {
  document.title = JSON.stringify({ inline, alias, other: \`chrome-extension://\${other}/reader.html\` });
});
`;

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("a content script's chrome-extension://${runtime.id} URLs inside templates load the add-on's files", { skip: !firefox && "no Firefox installed" }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><head><title>waiting</title></head><body><p>page</p></body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/page`;

  const manifest = {
    manifest_version: 3, name: "Self URL in template", version: "1",
    browser_specific_settings: { gecko: { id: "self-url.1a2b3c4d@lavaduct.test" } },
    host_permissions: ["http://127.0.0.1/*"],
    content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
    web_accessible_resources: [{ resources: ["i.png"], matches: ["http://127.0.0.1/*"] }],
  };
  // The conversion's source rewrites, applied to the content script.
  const dir = mkdtempSync(join(tmpdir(), "firefox-self-url-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "content.js"), CONTENT);
  applySourceRewrites(dir, manifest);
  const files = { "content.js": readFileSync(join(dir, "content.js"), "utf-8"), "i.png": PNG };

  const title = await loadAddon(manifest, files, async ({ chrome }) => {
    await chrome(`(() => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      globalThis.__selfUrlTab = win.gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      return 1;
    })()`);
    for (let i = 0; i < 150; i++) {
      const now = await chrome(`globalThis.__selfUrlTab.linkedBrowser.contentTitle`);
      if (now && now.startsWith("{")) return now;
      await sleep(100);
    }
    return "timed out";
  });
  assert.ok(title.startsWith("{"), title);
  assert.deepEqual(JSON.parse(title), {
    inline: "load",
    alias: "load",
    other: "chrome-extension://dahenjhkoodjbpjheillcadbppiidmhp/reader.html",
  });
});
