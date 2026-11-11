import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Claude in Chrome's Cowork bridge refuses a WebSocket handshake from a
// moz-extension:// origin (403) and accepts its chrome-extension:// one;
// Immersive Translate's language detection answers it with 403 "Not allowed by
// CORS", and its CSP names no hosts. The add-on's own requests get the Chrome
// origin; Firefox applies the rule only where the add-on has host access
// (test/firefox-backend-origin-host-access.test.js).

test("the background sets the Chrome origin on the add-on's own requests, whatever host they go to", async () => {
  const rules = [];
  const browser = fakeBrowser();
  browser.declarativeNetRequest = { updateSessionRules: (r) => { rules.push(plain(r)); return Promise.resolve(); } };
  runInContext(buildShim({ extensionId: "abcdefghijklmnopabcdefghijklmnop" }), { browser });
  await tick();
  assert.deepEqual(rules[0].removeRuleIds, [2147480001]);
  const [rule] = rules[0].addRules;
  assert.equal(rule.id, 2147480001);
  assert.deepEqual(rule.action.requestHeaders, [{ header: "origin", operation: "set", value: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }]);
  assert.equal(rule.condition.requestDomains, undefined, "no host list: Firefox limits the rule to hosts the add-on may access");
  assert.deepEqual(rule.condition.initiatorDomains, [new URL(EXT_ORIGIN).host], "web pages' and content scripts' requests keep their origin");
  assert.deepEqual(rule.condition.resourceTypes, ["websocket", "xmlhttprequest", "other"]);

  // Without a Chrome ID there is no origin to give.
  const none = fakeBrowser();
  none.declarativeNetRequest = { updateSessionRules: () => { throw new Error("must not be called"); } };
  runInContext(buildShim({}), { browser: none });
});
