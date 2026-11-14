// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-own-chrome-urls-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");
const { deriveChromeId } = await import("../dist/runtime/oauth-bridge.js");

const firefox = selectFirefox(findFirefoxInstalls());

// McAfee WebAdvisor's WASM builds chrome-extension://<its Chrome ID>/manifest.json
// at runtime, fetches it from the background and checks it against the manifest
// it shipped with. Firefox fails the request ("NetworkError when attempting to
// fetch resource"), and the file at the add-on's own origin is the manifest
// lavaduct rewrote; either way the check failed and the background never
// started its message dispatcher. Here the ID lives only in a .wasm file, and
// the background builds the URLs from pieces, as the WASM does.
const BACKGROUND = String.raw`
(async () => {
  const out = {};
  const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL("id.wasm"))).arrayBuffer());
  const id = String.fromCharCode(...bytes.slice(8, 40));
  const base = ["chrome", "extension://"].join("-") + id + "/";
  for (const [k, path] of [["manifest", "manifest" + ".json"], ["file", "data.txt"]]) {
    try { out[k] = await (await fetch(base + path)).text(); } catch (e) { out[k] = "ERR " + e.message; }
  }
  out.xhr = await new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("GET", base + "data.txt");
    x.onload = () => resolve(x.responseText);
    x.onerror = () => resolve("ERR xhr");
    x.send();
  });
  await fetch("http://127.0.0.1:" + PORT + "/report", { method: "POST", body: JSON.stringify(out) });
})();
`;

test(
  "the background reads its own files and shipped manifest at its Chrome origin, as in Chrome",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    let probe = null;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { if (req.url === "/report") probe = JSON.parse(body); res.end(); });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());

    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const ext = join(scratch, "ext");
    mkdirSync(ext);
    const manifestText = JSON.stringify({
      manifest_version: 3, name: "Own Chrome URL Probe", version: "1.0", key,
      host_permissions: ["http://127.0.0.1/*"],
      background: { service_worker: "bg.js" },
    }, null, 2);
    writeFileSync(join(ext, "manifest.json"), manifestText);
    writeFileSync(join(ext, "data.txt"), "own file");
    writeFileSync(join(ext, "bg.js"), BACKGROUND.replace("PORT", String(server.address().port)));
    // Like McAfee's WASM, the binary is what names the ID and manifest.json.
    const id = deriveChromeId({ key });
    writeFileSync(join(ext, "id.wasm"), Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.from(id + "manifest.json")]));
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    assert.ok(result.success, "the extension converts");
    assert.equal(result.chromeId, id);
    const staged = result.stagedPath;

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      await ff.installAddon(staged);
      for (let i = 0; i < 150 && !probe; i++) await sleep(100);
    } finally {
      await ff.close();
    }
    assert.ok(probe, "the background reported");
    assert.equal(probe.manifest, manifestText, "the manifest reads as it shipped");
    assert.equal(probe.file, "own file");
    assert.equal(probe.xhr, "own file");
  },
);
