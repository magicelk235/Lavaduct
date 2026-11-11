import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeShim } from "../dist/runtime/shim.js";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// A service worker has no localStorage, so a bundle gives itself one:
// `self.localStorage = polyfill` (Capital One Shopping's polyfills/localStorage.js).
// The converted worker runs in an event page, whose localStorage is a getter-only
// accessor, and the assignment throws in strict and module code, ending the
// background before it registers anything.

const POLYFILL = 'self.localStorage = (function () { function LS() {} LS.prototype.getItem = function (k) { return this[k] ?? null; }; return new LS(); })();';

test("the background of a converted worker that assigns localStorage can", () => {
  const files = { "polyfill.js": POLYFILL };
  const store = { getItem: () => "native" };
  const browser = fakeBrowser();
  // The event page's localStorage: an accessor with no setter on the global.
  const source = buildShim({ serviceWorker: true, serviceWorkerScript: "bg.js" }, files);
  const ctx = runInContext("Object.defineProperty(globalThis, 'localStorage', { get: () => __store, configurable: true, enumerable: true });\n" + source, { browser, globals: { __store: store } });
  assert.equal(vm.runInContext("localStorage.getItem('x')", ctx), "native", "reads still reach the real storage");
  vm.runInContext('"use strict";\n' + POLYFILL, ctx);
  assert.equal(vm.runInContext("localStorage.getItem('x')", ctx), null);
  assert.equal(vm.runInContext("typeof localStorage.constructor", ctx), "function");
});

test("other add-ons, and the add-on's pages, keep Firefox's localStorage untouched", () => {
  const files = { "polyfill.js": POLYFILL };
  for (const [config, href] of [
    [{ serviceWorker: false }, undefined],
    [{ serviceWorker: true, serviceWorkerScript: "bg.js" }, "moz-extension://5f2a6c1e-0d7b-4c39-9a31-3c3f0e6a7b11/popup.html"],
  ]) {
    const ctx = runInContext("Object.defineProperty(globalThis, 'localStorage', { get: () => 1, configurable: true, enumerable: true });\n" + buildShim(config, files), { browser: fakeBrowser(), href });
    assert.equal(typeof Object.getOwnPropertyDescriptor(ctx, "localStorage").get, "function");
  }
  const ctx = runInContext("Object.defineProperty(globalThis, 'localStorage', { get: () => 1, configurable: true, enumerable: true });\n" + buildShim({ serviceWorker: true, serviceWorkerScript: "bg.js" }, { "bg.js": "localStorage.getItem('a')" }), { browser: fakeBrowser() });
  assert.equal(typeof Object.getOwnPropertyDescriptor(ctx, "localStorage").get, "function", "a bundle that only reads it keeps the accessor");
});

test("Firefox runs a module background that assigns localStorage", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  let report;
  const reported = new Promise((resolve) => (report = resolve));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "access-control-allow-origin": "*" });
    res.end("ok");
    report(decodeURIComponent(req.url.slice(1)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const files = { "polyfill.js": POLYFILL, "bg.js": `import "./polyfill.js";\nfetch("http://127.0.0.1:${server.address().port}/" + encodeURIComponent(typeof localStorage.getItem + " " + localStorage.getItem("x")));` };
  const dir = mkdtempSync(join(tmpdir(), "ls-assign-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const shim = readFileSync(join(dir, writeShim(dir, { serviceWorker: true, serviceWorkerScript: "bg.js" })), "utf-8");
  rmSync(dir, { recursive: true, force: true });
  const manifest = {
    manifest_version: 3,
    name: "ls assign",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "ls-assign@example.com" } },
    host_permissions: ["<all_urls>"],
    background: { scripts: ["shim.js", "bg.js"], type: "module" },
  };
  const result = await loadAddon(manifest, { "shim.js": shim, ...files }, () => Promise.race([reported, new Promise((r) => setTimeout(r, 20_000, "no report: the background stopped"))]));
  assert.equal(result, "function null");
});
