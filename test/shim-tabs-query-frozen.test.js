import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeShim } from "../dist/runtime/shim.js";
import { buildShim, fakeBrowser, runInContext, plain, tick } from "./shim-sandbox.js";
import { firefox, loadAddon } from "./firefox-load.js";

// Chrome 132 added `frozen` to tabs.query's queryInfo. Firefox's schema has no
// such property and throws "Type error for parameter queryInfo (Unexpected
// property "frozen") for tabs.query" synchronously. Bardeen's background asks
// for its tabs with { frozen: false, discarded: false } and retries without
// frozen only on Chrome's wording of that error, so in Firefox the call failed.
// Firefox never freezes a tab the way Chrome does: no tab is frozen.

const BG = "async function tabs() { return chrome.tabs.query({ frozen: false, discarded: false }); }";

function shimmed(files = { "bg.js": BG }) {
  const seen = [];
  const browser = fakeBrowser({
    extra: {
      tabs: {
        query(info) {
          if (info && Object.prototype.hasOwnProperty.call(info, "frozen")) {
            throw new Error('Type error for parameter queryInfo (Unexpected property "frozen") for tabs.query.');
          }
          seen.push(plain(info));
          return Promise.resolve([{ id: 1 }, { id: 2 }]);
        },
      },
    },
  });
  const ctx = runInContext(buildShim({}, files), { browser });
  return { ctx, seen };
}

test("frozen: false matches every tab Firefox has, with the other conditions kept", async () => {
  const { ctx, seen } = shimmed();
  const tabs = await vm.runInContext("chrome.tabs.query({ frozen: false, discarded: false })", ctx);
  assert.deepEqual(plain(tabs), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(seen, [{ discarded: false }]);
});

test("frozen: true matches none, through a callback as well", async () => {
  const { ctx, seen } = shimmed();
  assert.deepEqual(plain(await vm.runInContext("chrome.tabs.query({ frozen: true, active: true })", ctx)), []);
  let got;
  vm.runInContext("chrome.tabs.query({ frozen: true }, (t) => { globalThis.got = t; })", ctx);
  await tick(5);
  got = ctx.got;
  assert.deepEqual(plain(got), []);
  assert.deepEqual(seen, []);
});

test("the query is left alone for a bundle that never names frozen", () => {
  const { ctx } = shimmed({ "bg.js": "chrome.tabs.query({})" });
  assert.throws(() => vm.runInContext("chrome.tabs.query({ frozen: false })", ctx), /Unexpected property "frozen"/);
});

test("in Firefox, a query with frozen answers as Chrome's does", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  let report;
  const reported = new Promise((resolve) => (report = resolve));
  const server = http.createServer((req, res) => {
    res.end("ok");
    if (req.url.startsWith("/report")) report(decodeURIComponent(req.url.slice("/report?".length)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const bg = `const send = (r) => fetch(${JSON.stringify(base)} + "/report?" + encodeURIComponent(JSON.stringify(r)));
const out = {};
Promise.resolve()
  .then(() => chrome.tabs.query({ frozen: false })).then((t) => { out.unfrozen = t.length; }, (e) => { out.unfrozen = "refused: " + e.message; })
  .then(() => chrome.tabs.query({})).then((t) => { out.all = t.length; })
  .then(() => new Promise((r) => chrome.tabs.query({ frozen: true }, (t) => { out.frozen = chrome.runtime.lastError ? "error" : t.length; r(); })))
  .catch((e) => { out.error = e.message; })
  .then(() => send(out));`;
  const dir = mkdtempSync(join(tmpdir(), "tabs-frozen-"));
  writeFileSync(join(dir, "bg.js"), bg);
  const shim = readFileSync(join(dir, writeShim(dir, {})), "utf-8");
  rmSync(dir, { recursive: true, force: true });
  const manifest = {
    manifest_version: 3,
    name: "tabs frozen",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "tabs-frozen.0123abcd@lavaduct" } },
    host_permissions: ["http://127.0.0.1/*"],
    background: { scripts: ["shim.js", "bg.js"] },
  };
  const result = await loadAddon(manifest, { "shim.js": shim, "bg.js": bg }, () => Promise.race([reported, new Promise((r) => setTimeout(r, 30_000, '"no report"'))]));
  const r = JSON.parse(result);
  assert.ok(r.all >= 1, result);
  assert.equal(r.unfrozen, r.all, result);
  assert.equal(r.frozen, 0, result);
});
