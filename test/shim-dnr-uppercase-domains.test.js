import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain } from "./shim-sandbox.js";

// Chrome lower-cases the domains in a DNR rule; Firefox's canonicalDomain refuses
// an upper-case one, and updateDynamicRules then rejects the whole call. The
// static rulesets get the same treatment in src/manifest/dnr.ts.

test("upper-case domains in a runtime rule are lower-cased, as Chrome does", () => {
  const calls = [];
  const browser = fakeBrowser({ extra: { declarativeNetRequest: { updateSessionRules: (o) => { calls.push(o); return Promise.resolve(); } } } });
  const ctx = runInContext(buildShim(), { browser });
  vm.runInContext(
    "chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: ['Example.COM', 'ok.org'], excludedInitiatorDomains: ['Sub.Example.com'] } }] })",
    ctx,
  );
  const condition = plain(calls[0]).addRules[0].condition;
  assert.deepEqual(condition.requestDomains, ["example.com", "ok.org"]);
  assert.deepEqual(condition.excludedInitiatorDomains, ["sub.example.com"]);
});
