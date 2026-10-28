import { test } from "node:test";
import assert from "node:assert/strict";
import { backendHosts } from "../dist/runtime/shim.js";
import { buildShim, fakeBrowser, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Claude in Chrome's Cowork bridge refuses a WebSocket handshake from a
// moz-extension:// origin (403) and accepts its chrome-extension:// one. The
// add-on's own requests to the backends its CSP names get the Chrome origin.

const CSP = "script-src 'self'; connect-src 'self' https://api.example.test wss://bridge.example.test https://*.ingest.example.test data:";

test("the backends are the hosts the add-on's CSP lets its pages connect to", () => {
  const manifest = { manifest_version: 3, content_security_policy: { extension_pages: CSP } };
  assert.deepEqual(backendHosts(manifest), ["api.example.test", "bridge.example.test", "ingest.example.test"]);
  assert.deepEqual(backendHosts({ manifest_version: 3 }), []);
});

test("the background sets the Chrome origin on the add-on's own requests to them", async () => {
  const rules = [];
  const browser = fakeBrowser();
  browser.declarativeNetRequest = { updateSessionRules: (r) => { rules.push(plain(r)); return Promise.resolve(); } };
  runInContext(buildShim({ extensionId: "abcdefghijklmnopabcdefghijklmnop", backendHosts: ["bridge.example.test"] }), { browser });
  await tick();
  const [rule] = rules[0].addRules;
  assert.deepEqual(rule.action.requestHeaders, [{ header: "origin", operation: "set", value: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }]);
  assert.deepEqual(rule.condition.requestDomains, ["bridge.example.test"]);
  assert.deepEqual(rule.condition.initiatorDomains, [new URL(EXT_ORIGIN).host], "web pages' requests to the same host keep their origin");

  // Without a Chrome ID there is no origin to give.
  const none = fakeBrowser();
  none.declarativeNetRequest = { updateSessionRules: () => { throw new Error("must not be called"); } };
  runInContext(buildShim({ backendHosts: ["bridge.example.test"] }), { browser: none });
});
