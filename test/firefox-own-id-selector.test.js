// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { buildShim } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// Hypothesis's boot script finds the config tag its background put in the page
// with document.querySelector("script.js-hypothesis-config[data-extension-id=" +
// chrome.runtime.id + "]"). A Chrome ID is 32 letters, always a CSS identifier.
// Firefox's runtime.id is the gecko ID (`<chromeId>.<salt>@lavaduct` for a
// converted add-on), and its `.` and `@` made the selector throw a SyntaxError.
// The boot script died before injecting the sidebar, and Firefox, failing to
// clone the DOMException for the background, rejected executeScript with
// "Script '…/boot.js' result is non-structured-clonable data". It only showed
// once the shim went first in injected files and gave them window.chrome.

const BOOT = `
(function () {
  var id = window.chrome.runtime.id;
  document.body.id = id;
  return {
    attribute: !!document.querySelector("script.cfg[data-extension-id=" + id + "]"),
    flagged: document.head.lastElementChild.matches("[data-extension-id=" + id + " i]"),
    closest: !!document.head.lastElementChild.closest("head > [data-extension-id=" + id + "]"),
    hash: document.documentElement.querySelectorAll("#" + id).length,
  };
})();
`;

const BG = `
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !String(tab.url).startsWith("http://127.0.0.1")) return;
  let out;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (id) => { const s = document.createElement("script"); s.type = "application/json"; s.className = "cfg"; s.setAttribute("data-extension-id", id); document.head.appendChild(s); },
      args: [chrome.runtime.id],
    });
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, files: ["boot.js"] });
    out = r.error ? { error: String(r.error) } : r.result;
  } catch (e) {
    out = { rejected: String((e && e.message) || e) };
  }
  await chrome.scripting.executeScript({ target: { tabId }, func: (t) => { document.title = t; }, args: [JSON.stringify(out)] });
});
`;

test("a file the add-on injects finds elements by runtime.id in an unquoted selector", { skip: !firefox && "no Firefox installed" }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><head><title>waiting</title></head><body><p>page</p></body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/page`;

  const manifest = {
    manifest_version: 3, name: "Own ID selector", version: "1",
    browser_specific_settings: { gecko: { id: "own-id-selector.1a2b3c4d@lavaduct.test" } },
    permissions: ["scripting", "tabs"],
    host_permissions: ["http://127.0.0.1/*"],
    background: { scripts: ["lavaduct-compat-shim.js", "bg.js"] },
  };
  const files = { "bg.js": BG, "boot.js": BOOT };
  files["lavaduct-compat-shim.js"] = buildShim({}, files);

  const title = await loadAddon(manifest, files, async ({ chrome }) => {
    await chrome(`(() => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      globalThis.__ownIdTab = win.gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      return 1;
    })()`);
    for (let i = 0; i < 150; i++) {
      const now = await chrome(`globalThis.__ownIdTab.linkedBrowser.contentTitle`);
      if (now && now.startsWith("{")) return now;
      await sleep(100);
    }
    return "timed out";
  });
  assert.ok(title.startsWith("{"), title);
  assert.deepEqual(JSON.parse(title), { attribute: true, flagged: true, closest: true, hash: 1 });
});
