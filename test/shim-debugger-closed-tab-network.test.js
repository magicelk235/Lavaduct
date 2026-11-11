import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, send } from "./debugger-sandbox.js";

// Network.enable puts webRequest listeners on <all_urls>, with request bodies,
// for as long as a session has Network on. A session that ends because its tab
// closed has to take them down as a detach does, or every request the browser
// makes keeps going through them.
test("closing the last tab with Network on removes the webRequest listeners", async () => {
  const { bg } = setup({ tabs: { 1: { url: "https://example.test/" }, 2: { url: "https://example.test/" } } });
  const b = bg.browser;
  const listening = () => Object.values(b.webRequest).reduce((n, ev) => n + ev.listeners.length, 0);
  await b.debugger.attach({ tabId: 1 });
  await b.debugger.attach({ tabId: 2 });
  await send(b, 1, "Network.enable");
  await send(b, 2, "Network.enable");
  assert.ok(listening() > 0);

  b.tabs.onRemoved.fire(1, {});
  assert.ok(listening() > 0, "tab 2 still has Network on");
  b.tabs.onRemoved.fire(2, {});
  assert.equal(listening(), 0);
});
