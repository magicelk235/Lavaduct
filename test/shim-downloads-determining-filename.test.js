import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, makeEvent, runInContext } from "./shim-sandbox.js";

// Firefox has no downloads.onDeterminingFilename: it takes the filename in
// downloads.download() up front, before the download has an id, so Chrome's
// "callback with the id, then suggest a name" can't be emulated. Image
// Downloader checks hasListener on it before every batch, and the TypeError
// meant nothing downloaded at all. The shim gives it an event that never
// fires: downloads keep Firefox's own filenames.

test("downloads.onDeterminingFilename exists where Firefox has none, and never fires", () => {
  const browser = fakeBrowser();
  const onChanged = makeEvent();
  browser.downloads = { download: () => Promise.resolve(1), onChanged };
  runInContext(buildShim(), { browser });
  const ev = browser.downloads.onDeterminingFilename;
  assert.ok(ev, "the event exists");
  const listener = () => {};
  assert.equal(ev.hasListener(listener), false);
  ev.addListener(listener);
  assert.equal(ev.hasListener(listener), true);
  ev.removeListener(listener);
  assert.equal(ev.hasListener(listener), false);
  assert.equal(browser.downloads.onChanged, onChanged, "Firefox's own events are left alone");
});

test("a Firefox that has onDeterminingFilename keeps its own", () => {
  const browser = fakeBrowser();
  const own = makeEvent();
  browser.downloads = { download: () => Promise.resolve(1), onDeterminingFilename: own };
  runInContext(buildShim(), { browser });
  assert.equal(browser.downloads.onDeterminingFilename, own);
});
