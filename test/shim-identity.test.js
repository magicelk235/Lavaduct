import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, makeStorageArea, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";

// Firefox implements identity.getRedirectURL and launchWebAuthFlow only. The
// shim builds getAuthToken on top of launchWebAuthFlow with Google's OAuth
// endpoint and Firefox's loopback redirect. Firefox's getManifest() drops keys
// it doesn't know, oauth2 among them, so the client id comes from the packaged
// manifest.json.

const PACKAGED = {
  manifest_version: 3, name: "T", version: "1",
  oauth2: { client_id: "123-abc.apps.googleusercontent.com", scopes: ["https://www.googleapis.com/auth/drive.file", "email"] },
};

function setup({ session = makeStorageArea(), redirect } = {}) {
  const browser = fakeBrowser();
  const flows = [];
  browser.identity = {
    getRedirectURL: (p = "") => "https://2f4c1aa9e0.extensions.allizom.org/" + p,
    launchWebAuthFlow(details) {
      flows.push(details);
      const u = new URL(details.url);
      const r = redirect ? redirect(u) : `${u.searchParams.get("redirect_uri")}#access_token=tok${flows.length}&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(u.searchParams.get("scope"))}`;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
  };
  browser.storage.session = session;
  const fetches = [];
  const fetch = async (url, init) => {
    fetches.push([String(url), init]);
    if (String(url) === EXT_ORIGIN + "/manifest.json") return new Response(JSON.stringify(PACKAGED));
    if (String(url).startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ sub: "10769150350006150715113082367", email: "user@example.com" }));
    }
    return new Response("", { status: 404 });
  };
  runInContext(buildShim(), { browser, globals: { fetch } });
  return { browser, flows, fetches, session };
}

test("getAuthToken runs Google's flow through the loopback redirect with the manifest's client and scopes", async () => {
  const { browser, flows } = setup();
  const res = plain(await browser.identity.getAuthToken({ interactive: true }));
  assert.equal(flows.length, 1);
  const u = new URL(flows[0].url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("client_id"), PACKAGED.oauth2.client_id);
  assert.equal(u.searchParams.get("response_type"), "token");
  assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1/mozoauth2/2f4c1aa9e0");
  assert.equal(u.searchParams.get("scope"), PACKAGED.oauth2.scopes.join(" "));
  assert.equal(flows[0].interactive, true);
  assert.deepEqual(res, { token: "tok1", grantedScopes: PACKAGED.oauth2.scopes });
});

test("a cached token is returned without another flow until removeCachedAuthToken drops it", async () => {
  const { browser, flows } = setup();
  const { token } = await browser.identity.getAuthToken({ interactive: true });
  assert.equal((await browser.identity.getAuthToken({})).token, token);
  assert.equal(flows.length, 1);
  await browser.identity.removeCachedAuthToken({ token });
  assert.equal((await browser.identity.getAuthToken({ interactive: true })).token, "tok2");
  assert.equal(flows.length, 2);
});

test("the token cache survives the event page being suspended", async () => {
  const session = makeStorageArea();
  const first = setup({ session });
  await first.browser.identity.getAuthToken({ interactive: true });
  const second = setup({ session });
  assert.equal((await second.browser.identity.getAuthToken({})).token, "tok1");
  assert.equal(second.flows.length, 0);
});

test("a non-interactive request asks Google not to prompt", async () => {
  const { browser, flows } = setup();
  await browser.identity.getAuthToken({ interactive: false, scopes: ["openid"] });
  assert.equal(flows[0].interactive, false);
  assert.equal(new URL(flows[0].url).searchParams.get("prompt"), "none");
  assert.equal(new URL(flows[0].url).searchParams.get("scope"), "openid");
});

test("callbacks receive (token, grantedScopes)", async () => {
  const { browser } = setup();
  const [token, scopes] = await new Promise((resolve) => browser.identity.getAuthToken({ interactive: true }, (...a) => resolve(a)));
  assert.equal(token, "tok1");
  assert.deepEqual(plain(scopes), PACKAGED.oauth2.scopes);
});

test("a refused grant rejects, and a callback sees runtime.lastError only while it runs", async () => {
  const { browser } = setup({ redirect: (u) => `${u.searchParams.get("redirect_uri")}#error=access_denied` });
  await assert.rejects(browser.identity.getAuthToken({ interactive: true }), /access_denied/);
  const seen = await new Promise((resolve) => browser.identity.getAuthToken({ interactive: true }, (token) => {
    resolve({ token, lastError: browser.runtime.lastError && browser.runtime.lastError.message });
  }));
  assert.equal(seen.token, undefined);
  assert.match(seen.lastError, /access_denied/);
  assert.equal(browser.runtime.lastError, null, "lastError is the native one again after the callback");
});

test("getProfileUserInfo reads the signed-in account through an email-scoped token", async () => {
  const { browser, fetches } = setup();
  assert.deepEqual(plain(await browser.identity.getProfileUserInfo()), { email: "", id: "" }, "nobody signed in yet");
  const { token } = await browser.identity.getAuthToken({ interactive: true });
  assert.deepEqual(plain(await browser.identity.getProfileUserInfo({})), { email: "user@example.com", id: "10769150350006150715113082367" });
  const call = fetches.find(([u]) => u.startsWith("https://www.googleapis.com/oauth2/v3/userinfo"));
  assert.equal(call[1].headers.Authorization, "Bearer " + token);
});

test("an extension without the identity permission gets no identity namespace from the shim", () => {
  const browser = fakeBrowser();
  runInContext(buildShim(), { browser });
  assert.equal(browser.identity, undefined);
});
