import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";

// getAuthToken shares a flow already running for the same scopes. A silent
// ({ interactive: false }) flow fails when the user has to sign in, so an
// interactive call made while one runs must start its own flow: joining the
// silent one handed it "interaction required" and never showed the sign-in.

const PACKAGED = {
  manifest_version: 3, name: "T", version: "1",
  oauth2: { client_id: "123-abc.apps.googleusercontent.com", scopes: ["email"] },
};

test("an interactive getAuthToken doesn't join a silent flow for the same scopes", async () => {
  const browser = fakeBrowser();
  const flows = [];
  browser.identity = {
    getRedirectURL: (p = "") => "https://2f4c1aa9e0.extensions.allizom.org/" + p,
    launchWebAuthFlow(details) {
      flows.push(details);
      const u = new URL(details.url);
      if (!details.interactive) {
        return new Promise((resolve) => setTimeout(() => resolve(`${u.searchParams.get("redirect_uri")}#error=interaction_required`), 20));
      }
      return Promise.resolve(`${u.searchParams.get("redirect_uri")}#access_token=signed-in&expires_in=3599&scope=email`);
    },
  };
  const fetch = async (url) => (String(url) === EXT_ORIGIN + "/manifest.json" ? new Response(JSON.stringify(PACKAGED)) : new Response("", { status: 404 }));
  runInContext(buildShim(), { browser, globals: { fetch } });

  const silent = browser.identity.getAuthToken({ interactive: false });
  const interactive = browser.identity.getAuthToken({ interactive: true });
  await assert.rejects(silent, /interaction_required/);
  assert.deepEqual(plain(await interactive), { token: "signed-in", grantedScopes: ["email"] });
  assert.deepEqual(flows.map((f) => f.interactive), [false, true]);
});
