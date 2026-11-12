import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { writeShim } from "../dist/runtime/shim.js";
import { buildShim, fakeBrowser, runInContext, plain } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// Chrome's storage.set reads a value's own enumerable properties, calling
// getters. Firefox 160 reads the items through Xrays, which see only data
// properties: storage.local drops a value held in an accessor at every depth,
// and every area drops a top-level key that is an accessor. Ghostery's options
// store (hybrids) keeps each record entry as a getter, so pausing a site wrote
// paused: {} and its pause rule never came.

// Copies what an Xray shows: own enumerable data properties, nested too.
function xrayCopy(v) {
  if (v === null || typeof v !== "object") return v;
  if (Object.prototype.toString.call(v) !== "[object Object]" && !Array.isArray(v)) return v;
  const out = Array.isArray(v) ? [] : {};
  for (const k of Object.keys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if ("value" in d) out[k] = xrayCopy(d.value);
  }
  return out;
}

function setup(code = "chrome.storage.local.set({ a: 1 });") {
  const browser = fakeBrowser();
  const calls = [];
  const data = {};
  browser.storage.local = {
    set(items, cb) {
      calls.push(items);
      Object.assign(data, xrayCopy(items));
      if (cb) { queueMicrotask(() => cb()); return undefined; }
      return Promise.resolve();
    },
    get() { return Promise.resolve(structuredClone(data)); },
  };
  const ctx = runInContext(buildShim({}, { "bg.js": code }), { browser });
  return { ctx, calls, data };
}

const VALUE = `(() => {
  const entry = {};
  Object.defineProperty(entry, "revokeAt", { get: () => 0, enumerable: true });
  Object.defineProperty(entry, "hidden", { get: () => 1, enumerable: false });
  const paused = {};
  Object.defineProperty(paused, "www.bbc.com", { get: () => entry, enumerable: true });
  const items = { options: { mode: "default", paused, list: [entry] } };
  Object.defineProperty(items, "top", { get: () => ({ t: 1 }), enumerable: true });
  return items;
})()`;

test("values held in getters are stored, as Chrome stores them", async () => {
  const { ctx, data } = setup();
  await vm.runInContext(`chrome.storage.local.set(${VALUE})`, ctx);
  assert.deepEqual(plain(data), {
    options: { mode: "default", paused: { "www.bbc.com": { revokeAt: 0 } }, list: [{ revokeAt: 0 }] },
    top: { t: 1 },
  });
});

test("the callback form too", async () => {
  const { ctx, data } = setup();
  await new Promise((resolve) => { ctx.done = resolve; vm.runInContext(`chrome.storage.local.set(${VALUE}, done)`, ctx); });
  assert.deepEqual(plain(data.options.paused), { "www.bbc.com": { revokeAt: 0 } });
});

test("items without getters reach Firefox as the same object", async () => {
  const { ctx, calls } = setup();
  await vm.runInContext("globalThis.items = { a: { b: [1, { c: 2 }] }, d: new Date(5), u: new Uint8Array(4) }; chrome.storage.local.set(items)", ctx);
  assert.equal(calls[0], ctx.items);
});

test("Firefox stores a getter's value", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  let report;
  const reported = new Promise((resolve) => (report = resolve));
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { res.writeHead(200, { "access-control-allow-origin": "*" }); res.end(); report(body); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const bg = `chrome.storage.local.set(${VALUE}, () => chrome.storage.local.get(null, (all) => fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)}, { method: "POST", body: JSON.stringify(all) })));`;
  const dir = mkdtempSync(join(tmpdir(), "storage-accessor-"));
  writeFileSync(join(dir, "bg.js"), bg);
  const shim = readFileSync(join(dir, writeShim(dir, {})), "utf-8");
  rmSync(dir, { recursive: true, force: true });
  const manifest = {
    manifest_version: 2,
    name: "storage accessor",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "storage-accessor@lavaduct" } },
    permissions: ["storage", "http://127.0.0.1/*"],
    background: { scripts: ["shim.js", "bg.js"] },
  };
  const result = await loadAddon(manifest, { "shim.js": shim, "bg.js": bg }, () => Promise.race([reported, new Promise((r) => setTimeout(r, 30_000, "no report"))]));
  assert.deepEqual(JSON.parse(result), {
    options: { mode: "default", paused: { "www.bbc.com": { revokeAt: 0 } }, list: [{ revokeAt: 0 }] },
    top: { t: 1 },
  });
});
