// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-backend-origin-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { deriveChromeId } = await import("../dist/runtime/oauth-bridge.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// Chrome sends every request an extension's own pages make with its
// chrome-extension://<id> origin, and some backends allow the extension by that
// name only: Immersive Translate's language detection answers Firefox's
// moz-extension://<uuid> origin with 403 "Not allowed by CORS", and its CSP
// names no hosts. Claude in Chrome's bridge refuses a WebSocket handshake from
// it. The add-on's own requests get the Chrome origin wherever Firefox lets the
// add-on change them, which is where it has host access and Firefox skips CORS
// for it. Where it has none, a server that reflects the origin it was sent
// answers Firefox's, and the request still passes Firefox's CORS check.
const KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAbackendOriginProbeKey";

const BACKGROUND = String.raw`
async function probe(base) {
  try {
    const r = await fetch(base + "/data", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    return r.status + " " + (await r.text());
  } catch (e) { return "failed: " + e.message; }
}
async function socket(url) {
  return await new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onerror = () => resolve("closed");
    ws.onclose = () => resolve("closed");
    setTimeout(() => resolve("timeout"), 5000);
  });
}
(async () => {
  // The shim adds its rule as the background starts.
  await new Promise((r) => setTimeout(r, 1000));
  const out = { granted: await probe(GRANTED), other: await probe(OTHER) };
  await socket(GRANTED.replace("http", "ws") + "/socket");
  await fetch(GRANTED + "/report", { method: "POST", body: JSON.stringify(out) });
})();
`;

const CONTENT = String.raw`
fetch(location.origin + "/from-content", { method: "POST", body: "{}" }).catch(() => {});
`;

test(
  "the add-on's own requests carry its Chrome origin where it has host access, and others still pass Firefox's CORS check",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const chromeId = deriveChromeId({ key: KEY });
    const seen = [];
    let report = null;
    const server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host.split(":")[0], path: req.url, origin: req.headers.origin ?? null });
      if (req.url === "/report") { let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { report = JSON.parse(body); }); }
      const cors = { "access-control-allow-origin": req.headers.origin ?? "*", "access-control-allow-headers": "content-type" };
      if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
      if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>page</p>"); return; }
      res.writeHead(200, { ...cors, "content-type": "text/plain" });
      res.end("ok");
    });
    server.on("upgrade", (req, sock) => {
      seen.push({ host: req.headers.host.split(":")[0], path: req.url, origin: req.headers.origin ?? null });
      sock.destroy();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const { port } = server.address();
    const granted = `http://127.0.0.1:${port}`;
    const other = `http://localhost:${port}`;

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Backend Origin Probe", version: "1.0", key: KEY,
      background: { service_worker: "bg.js" },
      // Firefox's default MV3 policy would upgrade ws:// to wss://.
      content_security_policy: { extension_pages: "script-src 'self'" },
      permissions: ["declarativeNetRequest"],
      host_permissions: ["http://127.0.0.1/*", "ws://127.0.0.1/*"],
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["cs.js"] }],
    }));
    writeFileSync(join(ext, "bg.js"), `const GRANTED = ${JSON.stringify(granted)}, OTHER = ${JSON.stringify(other)};\n` + BACKGROUND);
    writeFileSync(join(ext, "cs.js"), CONTENT);
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
      for (let i = 0; i < 300 && !report; i++) await sleep(100);
      await ff.chrome(`(() => {
        const w = Services.wm.getMostRecentWindow("navigator:browser");
        w.gBrowser.selectedTab = w.gBrowser.addTab(${JSON.stringify(granted + "/page")}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        return 1;
      })()`);
      for (let i = 0; i < 300 && !seen.some((s) => s.path === "/from-content"); i++) await sleep(100);
    } finally {
      await ff.close();
    }
    assert.ok(report, "the background reported its requests");
    const outcome = report;

    const chromeOrigin = `chrome-extension://${chromeId}`;
    const at = (host, path) => seen.filter((s) => s.host === host && s.path === path).map((s) => s.origin);
    assert.equal(outcome.granted, "200 ok", "the request to the host the add-on may access succeeds");
    assert.deepEqual([...new Set(at("127.0.0.1", "/data"))], [chromeOrigin], "and carries the Chrome origin");
    assert.deepEqual(at("127.0.0.1", "/socket"), [chromeOrigin], "so does a WebSocket handshake there");
    assert.equal(outcome.other, "200 ok", "a request to a host it may not access still passes Firefox's CORS check");
    const otherOrigins = at("localhost", "/data");
    assert.ok(otherOrigins.length > 0 && otherOrigins.every((o) => o?.startsWith("moz-extension://")), `and keeps Firefox's origin: ${otherOrigins}`);
    const fromContent = at("127.0.0.1", "/from-content");
    assert.ok(fromContent.length > 0, "the content script's request arrived");
    assert.ok(fromContent.every((o) => o !== chromeOrigin), `a content script's request keeps its own origin: ${fromContent}`);
  },
);
