import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";

// Chrome extensions build declarativeNetRequest rules from Chrome's enum
// objects. Firefox exposes only the enum types its schemas name, keyed its own
// way, and has no RuleActionType or HeaderOperation at all, so such code throws
// before the rule gets anywhere. Claude in Chrome builds its side panel's voice
// rules that way while answering the panel, so the panel saw an error instead
// of the answer.

/** What Firefox 159's declarativeNetRequest namespace carries. */
function firefoxDnr(calls) {
  return {
    ResourceType: { MAIN_FRAME: "main_frame", SUB_FRAME: "sub_frame", XMLHTTPREQUEST: "xmlhttprequest", WEBSOCKET: "websocket", OTHER: "other" },
    UnsupportedRegexReason: { SYNTAXERROR: "syntaxError", MEMORYLIMITEXCEEDED: "memoryLimitExceeded" },
    updateSessionRules: (options) => { calls.push(options); return Promise.resolve(); },
  };
}

const CHROME_STYLE_RULE = `chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [{ header: "Authorization", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: "Bearer t" }],
    },
    condition: {
      urlFilter: "|wss://app.example/voice?*",
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.WEBSOCKET],
      requestMethods: [chrome.declarativeNetRequest.RequestMethod.GET],
      domainType: chrome.declarativeNetRequest.DomainType.THIRD_PARTY,
    },
  }],
})`;

test("a rule built from Chrome's declarativeNetRequest enums reaches Firefox with the values it takes", () => {
  const calls = [];
  const browser = fakeBrowser({ extra: { declarativeNetRequest: firefoxDnr(calls) } });
  const ctx = runInContext(buildShim(), { browser });
  vm.runInContext(CHROME_STYLE_RULE, ctx);

  const rule = plain(calls[0]).addRules[0];
  assert.deepEqual(rule.action, { type: "modifyHeaders", requestHeaders: [{ header: "Authorization", operation: "set", value: "Bearer t" }] });
  assert.deepEqual(rule.condition, { urlFilter: "|wss://app.example/voice?*", resourceTypes: ["websocket"], requestMethods: ["get"], domainType: "thirdParty" });
  // Chrome's full objects, keyed the way Chrome keys them.
  assert.deepEqual(plain(browser.declarativeNetRequest.RuleActionType), {
    BLOCK: "block", REDIRECT: "redirect", ALLOW: "allow", UPGRADE_SCHEME: "upgradeScheme",
    MODIFY_HEADERS: "modifyHeaders", ALLOW_ALL_REQUESTS: "allowAllRequests",
  });
  assert.deepEqual(plain(browser.declarativeNetRequest.HeaderOperation), { APPEND: "append", SET: "set", REMOVE: "remove" });
});

test("Firefox's own enum objects stay, and gain Chrome's spelling of their keys", () => {
  const browser = fakeBrowser({ extra: { declarativeNetRequest: firefoxDnr([]) } });
  const reasons = browser.declarativeNetRequest.UnsupportedRegexReason;
  const types = browser.declarativeNetRequest.ResourceType;
  const native = { BLOCK: "block", REDIRECT: "redirect", ALLOW: "allow", UPGRADE_SCHEME: "upgradeScheme", MODIFY_HEADERS: "modifyHeaders", ALLOW_ALL_REQUESTS: "allowAllRequests" };
  browser.declarativeNetRequest.RuleActionType = native;
  runInContext(buildShim(), { browser, href: EXT_ORIGIN + "/panel.html" });

  const dnr = browser.declarativeNetRequest;
  assert.equal(dnr.RuleActionType, native, "an object Firefox has is not replaced");
  assert.equal(dnr.UnsupportedRegexReason, reasons);
  assert.deepEqual(plain(reasons), { SYNTAXERROR: "syntaxError", MEMORYLIMITEXCEEDED: "memoryLimitExceeded", SYNTAX_ERROR: "syntaxError", MEMORY_LIMIT_EXCEEDED: "memoryLimitExceeded" });
  assert.equal(dnr.ResourceType, types);
  assert.deepEqual(Object.keys(types), ["MAIN_FRAME", "SUB_FRAME", "XMLHTTPREQUEST", "WEBSOCKET", "OTHER"], "Firefox's resource types are its own");
});

test("each namespace of an MV2 page gets the objects, and a context without declarativeNetRequest gets none", () => {
  const browser = fakeBrowser({ extra: { declarativeNetRequest: firefoxDnr([]) } });
  const chrome = fakeBrowser({ extra: { declarativeNetRequest: firefoxDnr([]) } });
  runInContext(buildShim(), { browser, chrome, href: EXT_ORIGIN + "/options.html" });
  assert.equal(browser.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, "modifyHeaders");
  assert.equal(chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, "modifyHeaders");

  const content = fakeBrowser();
  const ctx = runInContext(buildShim(), { browser: content, href: "https://example.com/" });
  assert.equal(vm.runInContext("typeof chrome.declarativeNetRequest", ctx), "undefined");
});
