import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain, tick } from "./shim-sandbox.js";

// lavaduct adds session rules of its own: the backend Origin rule (2147480001)
// and the frame grants' rules (2147480100-2147480199). A common startup clears
// every session rule (Requestly: getSessionRules, then removeRuleIds of all),
// which took lavaduct's out too, and code numbering its rules after the
// highest ID it sees started next to them.

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";

function firefoxDnr() {
  const rules = new Map();
  return {
    rules,
    getSessionRules: () => Promise.resolve([...rules.values()]),
    updateSessionRules: ({ removeRuleIds = [], addRules = [] } = {}) => {
      for (const id of removeRuleIds) rules.delete(id);
      for (const r of addRules) rules.set(r.id, r);
      return Promise.resolve();
    },
    updateDynamicRules: () => Promise.resolve(),
  };
}

function background(config) {
  const dnr = firefoxDnr();
  const browser = fakeBrowser({ extra: { declarativeNetRequest: dnr } });
  const ctx = runInContext(buildShim(config), { browser });
  return { ctx, dnr };
}

const CLEAR_ALL = "(async () => { const r = await chrome.declarativeNetRequest.getSessionRules(); globalThis.seen = r.map((x) => x.id); await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [...seen, 2147480120], addRules: [{ id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'ads' } }] }); })()";

test("the add-on neither sees nor removes lavaduct's own session rules", async () => {
  const { ctx, dnr } = background({ extensionId: CHROME_ID, backendHosts: ["api.example.com"] });
  await tick();
  dnr.rules.set(2147480120, { id: 2147480120 }); // a frame grant's rule
  dnr.rules.set(7, { id: 7 });
  await vm.runInContext(CLEAR_ALL, ctx);
  assert.deepEqual([...ctx.seen], [7]);
  assert.deepEqual([...dnr.rules.keys()].sort(), [1, 2147480001, 2147480120]);

  // Firefox's own methods stay reachable for lavaduct's frame grants.
  const all = await ctx.chrome.declarativeNetRequest.getSessionRules.__lavaductNative.call(dnr);
  assert.deepEqual(plain(all.map((r) => r.id)).sort(), [1, 2147480001, 2147480120]);
  vm.runInContext("chrome.declarativeNetRequest.getSessionRules((r) => { globalThis.cb = r.map((x) => x.id); })", ctx);
  await tick(5);
  assert.deepEqual([...ctx.cb], [1]);
});

test("an add-on lavaduct adds no session rules to keeps Firefox's getSessionRules", () => {
  const { dnr } = background({});
  assert.equal(dnr.getSessionRules.name, "getSessionRules");
  const grants = background({ frameGrants: true });
  assert.notEqual(grants.dnr.getSessionRules.name, "getSessionRules");
});
