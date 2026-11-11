import { test } from "node:test";
import assert from "node:assert/strict";
import { plain } from "./shim-sandbox.js";
import { setup, send } from "./debugger-sandbox.js";

// A navigation that only changes the fragment stays in the document: Firefox
// reports it with webNavigation.onReferenceFragmentUpdated and never fires
// onCommitted, so Page.navigate waiting for a commit sat out its 30-second
// timeout. Chrome answers at once, without a loaderId.
test("Page.navigate to a fragment of the current page answers at once, without a loaderId", async () => {
  const { bg } = setup();
  const b = bg.browser;
  b.tabs.update = (id, props) => {
    setTimeout(() => b.webNavigation.onReferenceFragmentUpdated.fire({ tabId: id, frameId: 0, url: props.url, timeStamp: 1 }), 5);
    return Promise.resolve({ id, ...props });
  };
  await b.debugger.attach({ tabId: 1 });
  const answer = send(b, 1, "Page.navigate", { url: "https://example.test/#part" });
  const winner = await Promise.race([answer, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500).unref())]);
  assert.deepEqual(plain(winner), { frameId: "1" });
});

test("a pushState by the page doesn't answer a cross-document Page.navigate", async () => {
  const { bg } = setup();
  const b = bg.browser;
  b.tabs.update = (id, props) => {
    setTimeout(() => {
      b.webNavigation.onHistoryStateUpdated.fire({ tabId: id, frameId: 0, url: "https://example.test/spa-route", timeStamp: 1 });
      setTimeout(() => b.webNavigation.onCommitted.fire({ tabId: id, frameId: 0, parentFrameId: -1, url: props.url, timeStamp: 2 }), 20);
    }, 5);
    return Promise.resolve({ id, ...props });
  };
  await b.debugger.attach({ tabId: 1 });
  const answer = await send(b, 1, "Page.navigate", { url: "https://other.test/" });
  assert.deepEqual(plain(answer), { frameId: "1", loaderId: "1" });
});
