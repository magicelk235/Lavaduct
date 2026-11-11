// Firefox's runtime.getContexts() has no OFFSCREEN_DOCUMENT context type, but the
// shim answers a filter naming it from its offscreen emulation, so the analyzer
// reports the string form as shimmed. runtime.ContextType.OFFSCREEN_DOCUMENT is
// still undefined in Firefox, and a filter built from it throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanExtension } from "../dist/analyze/analyze.js";
import { DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { firefox, loadAddon } from "./firefox-load.js";

function scan(code) {
  const dir = mkdtempSync(join(tmpdir(), "lavaduct-ctx-"));
  try {
    mkdirSync(join(dir, "icons"));
    writeFileSync(join(dir, "sw.js"), code);
    return scanExtension(dir, { manifest_version: 3, name: "X", version: "1.0", background: { service_worker: "sw.js" } }, { minFirefox: DEFAULT_MIN_FIREFOX });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a getContexts filter naming OFFSCREEN_DOCUMENT is reported as shimmed", () => {
  const issues = scan(`chrome.offscreen.createDocument({ url: "o.html", reasons: ["DOM_PARSER"], justification: "x" });
chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });`);
  const ctx = issues.filter((i) => i.message.includes("OFFSCREEN_DOCUMENT"));
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].severity, "info");
  assert.equal(ctx[0].shimmed, true);
  const offscreen = issues.find((i) => i.message.startsWith("chrome.offscreen is emulated"));
  assert.doesNotMatch(offscreen.fix, /doesn't list/);
});

test("the ContextType member Firefox lacks is still a warning", () => {
  const issues = scan("chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });");
  const [issue] = issues.filter((i) => i.message.includes("ContextType.OFFSCREEN_DOCUMENT"));
  assert.equal(issue.severity, "warning");
  assert.ok(!issue.shimmed);
});

test("Firefox has no OFFSCREEN_DOCUMENT context type or ContextType member", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async (t) => {
  let resolveReport;
  const report = new Promise((resolve) => (resolveReport = resolve));
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.end();
      resolveReport(JSON.parse(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const background = `(async () => {
    let threw = false;
    try { await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }); } catch (e) { threw = true; }
    const member = browser.runtime.ContextType && browser.runtime.ContextType.OFFSCREEN_DOCUMENT;
    await fetch("http://127.0.0.1:${server.address().port}/", { method: "POST", mode: "no-cors", body: JSON.stringify({ threw, member: member === undefined ? null : member }) });
  })();`;
  const facts = await loadAddon(
    {
      manifest_version: 3, name: "Contexts", version: "1.0",
      browser_specific_settings: { gecko: { id: "contexts@example.com" } },
      host_permissions: ["http://127.0.0.1/*"],
      background: { scripts: ["bg.js"] },
    },
    { "bg.js": background },
    () => report,
  );
  assert.deepEqual(facts, { threw: true, member: null });
});
