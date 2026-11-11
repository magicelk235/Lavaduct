import { test } from "node:test";
import assert from "node:assert/strict";
import { plain, tick } from "./shim-sandbox.js";
import { setup, send } from "./debugger-sandbox.js";

// Firefox 159 reports most navigations it starts from tabs.update twice: the
// first load is cancelled with webNavigation.onErrorOccurred "Error code
// 2152398850" (NS_BINDING_ABORTED) and loaded again, and the second one
// commits. Measured in a headless Firefox: error, beforeNavigate, committed;
// or beforeNavigate, beforeNavigate, error, committed. A Page.navigate that
// took the first error as the answer reported a failure for a page that
// loaded, and Page.frameStoppedLoading came in the middle of the load.
const ABORTED = "Error code 2152398850";

function navigatingTab(fire) {
  const env = setup({ tabs: { 1: { url: "https://example.test/", status: "complete" } } });
  const b = env.bg.browser;
  const nav = b.webNavigation;
  b.tabs.update = (id, props) => {
    env.tabs[id].status = "loading";
    setTimeout(() => fire(nav, id, props.url, env.tabs[id]), 5);
    return Promise.resolve({ id, ...props });
  };
  return env;
}

test("a navigation Firefox aborts and loads again answers Page.navigate when it commits", async () => {
  const { bg } = navigatingTab(async (nav, tabId, url, tab) => {
    nav.onErrorOccurred.fire({ tabId, frameId: 0, url, error: ABORTED, timeStamp: 1 });
    nav.onBeforeNavigate.fire({ tabId, frameId: 0, parentFrameId: -1, url, timeStamp: 2 });
    await tick(20);
    nav.onCommitted.fire({ tabId, frameId: 0, parentFrameId: -1, url, timeStamp: 3 });
    tab.status = "complete";
    nav.onCompleted.fire({ tabId, frameId: 0, url, timeStamp: 4 });
  });
  const b = bg.browser;
  const events = [];
  b.debugger.onEvent.addListener((source, method) => events.push(method));
  await b.debugger.attach({ tabId: 1 });
  await send(b, 1, "Page.enable");
  assert.deepEqual(plain(await send(b, 1, "Page.navigate", { url: "https://example.test/next" })), { frameId: "1", loaderId: "1" });
  await tick(10);
  assert.deepEqual(events.filter((m) => /Loading$|frameNavigated/.test(m)), ["Page.frameStartedLoading", "Page.frameNavigated", "Page.frameStoppedLoading"]);
});

test("the other order Firefox uses, a second beforeNavigate ahead of the error, answers on commit too", async () => {
  const { bg } = navigatingTab(async (nav, tabId, url) => {
    nav.onBeforeNavigate.fire({ tabId, frameId: 0, parentFrameId: -1, url, timeStamp: 1 });
    nav.onBeforeNavigate.fire({ tabId, frameId: 0, parentFrameId: -1, url, timeStamp: 2 });
    nav.onErrorOccurred.fire({ tabId, frameId: 0, url, error: ABORTED, timeStamp: 3 });
    await tick(20);
    nav.onCommitted.fire({ tabId, frameId: 0, parentFrameId: -1, url, timeStamp: 4 });
  });
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  assert.deepEqual(plain(await send(b, 1, "Page.navigate", { url: "https://example.test/next" })), { frameId: "1", loaderId: "1" });
});

test("an aborted navigation that doesn't go on still fails, and so does any other error", async () => {
  const stopped = navigatingTab((nav, tabId, url, tab) => {
    tab.status = "complete";
    nav.onErrorOccurred.fire({ tabId, frameId: 0, url, error: ABORTED, timeStamp: 1 });
  });
  await stopped.bg.browser.debugger.attach({ tabId: 1 });
  assert.equal((await send(stopped.bg.browser, 1, "Page.navigate", { url: "https://example.test/next" })).errorText, ABORTED);

  const refused = navigatingTab((nav, tabId, url) => {
    nav.onErrorOccurred.fire({ tabId, frameId: 0, url, error: "Error code 2152398861", timeStamp: 1 });
  });
  await refused.bg.browser.debugger.attach({ tabId: 1 });
  assert.equal((await send(refused.bg.browser, 1, "Page.navigate", { url: "https://example.test/next" })).errorText, "Error code 2152398861");
});
