import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeShim } from "../dist/runtime/shim.js";
import { buildShim, fakeBrowser, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// Chrome code that knows its own ID passes it to runtime.sendMessage and
// runtime.connect, and Chrome treats that as a message to itself. Compose AI's
// popup builds its webext-redux store with extensionId set to its Chrome ID,
// so the store's port went to an extension Firefox doesn't have and the popup
// waited for its state forever, blank. Firefox's own ID is the gecko ID.

const CHROME_ID = "ddlbpiadoechcolndfeaonajmngmhblj";

function callsAfter(script, files) {
  const browser = fakeBrowser({
    extra: {},
  });
  browser.runtime.connect = (...args) => { browser.calls.push(["runtime.connect", ...args]); return { name: "p" }; };
  const ctx = runInContext(buildShim({ extensionId: CHROME_ID }, files), { browser, href: EXT_ORIGIN + "/popup.html" });
  vm.runInContext(script, ctx);
  return browser.calls.filter((c) => c[0].startsWith("runtime."));
}

const USES_ID = { "popup.js": `const id = "${CHROME_ID}"; chrome.runtime.connect(id, { name: "x" });` };

test("a message or port addressed to the add-on's own Chrome ID goes to the add-on itself", () => {
  const calls = callsAfter(`
    chrome.runtime.sendMessage("${CHROME_ID}", { a: 1 });
    chrome.runtime.sendMessage("${CHROME_ID.toUpperCase()}", { a: 2 }, {}, () => {});
    chrome.runtime.connect("${CHROME_ID}", { name: "store" });
    chrome.runtime.connect("${CHROME_ID}");
  `, USES_ID);
  assert.deepEqual(calls.map((c) => c[1]), ["addon@example.test", "addon@example.test", "addon@example.test", "addon@example.test"]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { a: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2][2])), { name: "store" });
});

test("other IDs, a lone string message and calls without an ID are left alone", () => {
  const calls = callsAfter(`
    chrome.runtime.sendMessage("${CHROME_ID}");
    chrome.runtime.sendMessage("otherextensionidaaaaaaaaaaaaaaaa", { a: 1 });
    chrome.runtime.sendMessage({ a: 1 });
    chrome.runtime.connect({ name: "y" });
  `, USES_ID);
  assert.deepEqual(calls.map((c) => c[1]), [CHROME_ID, "otherextensionidaaaaaaaaaaaaaaaa", calls[2][1], calls[3][1]]);
  assert.equal(typeof calls[2][1], "object");
  assert.equal(typeof calls[3][1], "object");
});

test("the rewrite is only emitted for a bundle that has its Chrome ID in its code", () => {
  const calls = callsAfter(`chrome.runtime.sendMessage("${CHROME_ID}", { a: 1 });`, { "popup.js": "chrome.runtime.sendMessage({})" });
  assert.equal(calls[0][1], CHROME_ID);
});

test("in Firefox, an extension page reaches its background through its Chrome ID", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  let report;
  const reported = new Promise((resolve) => (report = resolve));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "access-control-allow-origin": "*" });
    res.end("ok");
    if (req.url.startsWith("/report")) report(decodeURIComponent(req.url.slice("/report?".length)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = `const send = (r) => fetch(${JSON.stringify(base)} + "/report?" + encodeURIComponent(JSON.stringify(r)));
const out = {};
const port = chrome.runtime.connect("${CHROME_ID}", { name: "store" });
port.onMessage.addListener((m) => { out.port = m; });
port.onDisconnect.addListener(() => { out.port = out.port || "disconnected"; });
chrome.runtime.sendMessage("${CHROME_ID}", { q: "ping" }, (answer) => {
  out.message = chrome.runtime.lastError ? "error: " + chrome.runtime.lastError.message : answer;
  setTimeout(() => send(out), 500);
});`;
  const bg = `chrome.runtime.onMessage.addListener((m, s, reply) => { reply("pong " + m.q); });
chrome.runtime.onConnect.addListener((p) => { p.postMessage("state for " + p.name); });
chrome.tabs.create({ url: chrome.runtime.getURL("page.html") });`;
  const dir = mkdtempSync(join(tmpdir(), "own-chrome-id-"));
  writeFileSync(join(dir, "page.js"), page);
  const shim = readFileSync(join(dir, writeShim(dir, { extensionId: CHROME_ID })), "utf-8");
  rmSync(dir, { recursive: true, force: true });
  const manifest = {
    manifest_version: 3,
    name: "own chrome id",
    version: "1.0",
    browser_specific_settings: { gecko: { id: `${CHROME_ID}.0123abcd@lavaduct` } },
    host_permissions: ["http://127.0.0.1/*"],
    background: { scripts: ["shim.js", "bg.js"] },
  };
  const files = { "shim.js": shim, "bg.js": bg, "page.js": page, "page.html": '<script src="shim.js"></script><script src="page.js"></script>' };
  const result = await loadAddon(manifest, files, () => Promise.race([reported, new Promise((r) => setTimeout(r, 30_000, '"no report"'))]));
  const r = JSON.parse(result);
  assert.equal(r.message, "pong ping", result);
  assert.equal(r.port, "state for store", result);
});
