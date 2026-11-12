import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { makePage, setup } from "./debugger-sandbox.js";

// Firefox runs a page's inline scripts, and its DOMContentLoaded and load
// handlers, before a hook put in through executeScript after the commit can
// land, so dialogs and console calls made while a page loaded went unreported
// (test/firefox-debugger-dialog-during-load.test.js shows it in Firefox). While a
// tab is attached, each document it loads has its body held back by a stream
// filter until the hooks are in, then passed on unchanged.

function fakeFilters() {
  const filters = [];
  const create = (requestId) => {
    const f = {
      requestId,
      log: [],
      page: null,
      write(data) { this.log.push({ write: data, hooked: vm.runInContext("window.confirm('Leave?')", this.page()) === true }); },
      disconnect() { this.log.push("disconnect"); },
      close() { this.log.push("close"); },
    };
    filters.push(f);
    return f;
  };
  return { filters, create };
}

async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
}

test("a document an attached tab loads is held back until the hooks are in it", async () => {
  const top = makePage();
  const frames = { 0: top };
  const { bg } = setup({ page: top, frames });
  const b = bg.browser;
  const { filters, create } = fakeFilters();
  b.webRequest.filterResponseData = create;

  assert.equal(b.webRequest.onBeforeRequest.listeners.length, 0, "nothing is held while no tab is attached");
  await b.debugger.attach({ tabId: 1 });
  assert.equal(b.webRequest.onBeforeRequest.listeners.length, 1);
  const [hold] = b.webRequest.onBeforeRequest.listeners;

  hold({ requestId: "1", tabId: 2, frameId: 0, type: "main_frame", url: "https://other.test/" });
  assert.equal(filters.length, 0, "a tab that isn't attached loads untouched");

  hold({ requestId: "2", tabId: 1, frameId: 0, type: "main_frame", url: "https://example.test/next" });
  const [f] = filters;
  f.page = () => frames[0];
  f.onstart();
  f.ondata({ data: "<script>confirm('Leave?')" });
  f.ondata({ data: "</script>" });
  assert.deepEqual(f.log, [], "none of the body reaches the page before its hooks");

  // Firefox creates the new document when the response starts, and reports the commit.
  const next = makePage({ href: "https://example.test/next" });
  next.browser = top.browser;
  frames[0] = next;
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, parentFrameId: -1, url: "https://example.test/next", timeStamp: Date.now() });
  await until(() => f.log.length);
  assert.deepEqual(f.log, [
    { write: "<script>confirm('Leave?')", hooked: true },
    { write: "</script>", hooked: true },
    "disconnect",
  ], "the held bytes go on unchanged once the hooks are in, and the rest flows past");
});

test("a held document whose response already ended is closed, and detaching lets every held document go", async () => {
  const top = makePage();
  const child = makePage({ href: "https://frame.test/" });
  const frames = { 0: top, 7: child };
  const { bg } = setup({ page: top, frames });
  const b = bg.browser;
  const { filters, create } = fakeFilters();
  b.webRequest.filterResponseData = create;
  await b.debugger.attach({ tabId: 1 });
  const [hold] = b.webRequest.onBeforeRequest.listeners;

  hold({ requestId: "3", tabId: 1, frameId: 7, type: "sub_frame", url: "https://frame.test/" });
  const [frame] = filters;
  frame.page = () => frames[7];
  frame.onstart();
  frame.ondata({ data: "<p>done" });
  frame.onstop();
  const next = makePage({ href: "https://frame.test/" });
  next.browser = child.browser;
  frames[7] = next;
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 7, parentFrameId: 0, url: "https://frame.test/", timeStamp: Date.now() });
  await until(() => frame.log.length);
  assert.deepEqual(frame.log, [{ write: "<p>done", hooked: true }, "close"]);

  // A response that never commits (a download) is let go when the tab is.
  hold({ requestId: "4", tabId: 1, frameId: 0, type: "main_frame", url: "https://example.test/file.zip" });
  const download = filters[1];
  download.page = () => frames[0];
  download.onstart();
  download.ondata({ data: "PK" });
  await b.debugger.detach({ tabId: 1 });
  assert.deepEqual(download.log.map((l) => l.write ?? l), ["PK", "disconnect"]);
  assert.equal(b.webRequest.onBeforeRequest.listeners.length, 0, "nothing is held once no tab is attached");
});

test("a document released before its response starts goes through untouched", async () => {
  const top = makePage();
  const frames = { 0: top };
  const { bg } = setup({ page: top, frames });
  const b = bg.browser;
  const { filters, create } = fakeFilters();
  b.webRequest.filterResponseData = create;
  await b.debugger.attach({ tabId: 1 });
  const [hold] = b.webRequest.onBeforeRequest.listeners;
  hold({ requestId: "5", tabId: 1, frameId: 0, type: "main_frame", url: "https://example.test/" });
  const [f] = filters;
  f.page = () => frames[0];
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, parentFrameId: -1, url: "https://example.test/", timeStamp: Date.now() });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(f.log, [], "a filter can't be disconnected before it starts");
  f.onstart();
  assert.deepEqual(f.log, ["disconnect"]);
});
