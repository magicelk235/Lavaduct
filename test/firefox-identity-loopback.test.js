// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-identity-loopback-live-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { setUserPrefs } = await import("../dist/firefox/install.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { startPrivilegedFirefox } = await import("./firefox-devtools.js");

const firefox = selectFirefox(findFirefoxInstalls());

// The shim's getAuthToken runs Google's flow through launchWebAuthFlow with
// Firefox's loopback redirect, http://127.0.0.1/mozoauth2/<hash>. Firefox stops
// the flow window's navigation there and hands the URL back, without anything
// listening on port 80, because the auth URL names that redirect in
// redirect_uri (Firefox intercepts the redirect_uri it's given, else
// getRedirectURL()'s). This runs the whole path in Firefox against a stand-in
// provider: a DNR rule of the probe's sends the request for Google's endpoint
// to a local server, which answers with a sign-in page, as Google does for
// someone not signed in, so Firefox opens its flow window; the page then goes
// on to a URL that redirects to redirect_uri with a token in the fragment, as
// Google's implicit grant does after sign-in. Google itself refuses the
// loopback for a Chrome extension client (invalid_request), so this is what
// works for a client that allows it. DNS is pinned to 127.0.0.1 so no request
// leaves the machine.
test(
  "getAuthToken completes through Firefox's loopback redirect when the provider honours it",
  { skip: firefox ? false : "no Firefox install found", timeout: 180_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const seen = [];
    const asked = [];
    const approved = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/log") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => { seen.push(JSON.parse(body)); res.end("ok"); });
        return;
      }
      if (u.pathname === "/o/oauth2/v2/auth") {
        asked.push({ ...Object.fromEntries(u.searchParams), dest: req.headers["sec-fetch-dest"] ?? "" });
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>sign in</title><script>setTimeout(() => { location.href = "/approve" + location.search; }, 200);</script>`);
        return;
      }
      if (u.pathname === "/approve") {
        approved.push(req.headers["sec-fetch-dest"] ?? "");
        res.writeHead(302, { location: `${u.searchParams.get("redirect_uri")}#access_token=tok-1&token_type=Bearer&expires_in=3600&scope=${encodeURIComponent(u.searchParams.get("scope"))}` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Identity Loopback Probe", version: "1.0",
      permissions: ["identity", "declarativeNetRequest"],
      host_permissions: ["https://accounts.google.com/*"],
      oauth2: { client_id: "lavaduct-test.apps.googleusercontent.com", scopes: ["https://www.googleapis.com/auth/userinfo.email"] },
      background: { service_worker: "sw.js" },
    }));
    // The log server sends no CORS headers; the request arrives, the fetch rejects.
    writeFileSync(join(ext, "sw.js"), `const report = (o) => fetch(${JSON.stringify(base + "/log")}, { method: "POST", body: JSON.stringify(o) }).catch(() => {});
chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [7], addRules: [{ id: 7, priority: 1,
  action: { type: "redirect", redirect: { regexSubstitution: ${JSON.stringify(base + "/o/oauth2/v2/auth?\\1")} } },
  condition: { regexFilter: "^https://accounts\\\\.google\\\\.com/o/oauth2/v2/auth\\\\?(.*)$", resourceTypes: ["main_frame"] } }] })
  .then(() => chrome.identity.getAuthToken({ interactive: true }))
  .then((first) => chrome.identity.getAuthToken({ interactive: false }).then((cached) => report({ first, cached })))
  .catch((e) => report({ error: String(e && e.message || e) }));
`);
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    assert.ok(result.success, "the extension converts");

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    setUserPrefs(profile, { "network.dns.forceResolve": '"127.0.0.1"' });
    const ff = await startPrivilegedFirefox(firefox, profile);
    try {
      await ff.installAddon(result.stagedPath);
      for (const end = Date.now() + 90_000; Date.now() < end && !seen.length; ) await sleep(100);
    } finally {
      await ff.close();
    }
    assert.equal(seen.length, 1, `the probe reported once: ${JSON.stringify(seen)}`);
    assert.deepEqual(seen[0].first, { token: "tok-1", grantedScopes: ["https://www.googleapis.com/auth/userinfo.email"] }, JSON.stringify(seen[0]));
    assert.deepEqual(seen[0].cached, seen[0].first, "the second, silent call is answered from the cache");
    assert.deepEqual(approved, ["document"], "the token came through the flow window, once");
    assert.match(asked[0].redirect_uri, /^http:\/\/127\.0\.0\.1\/mozoauth2\/[0-9a-f]{40}$/);
    assert.equal(asked[0].client_id, "lavaduct-test.apps.googleusercontent.com");
  },
);
