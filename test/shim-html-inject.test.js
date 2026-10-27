import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectShimIntoHtmlPages, SHIM_FILENAME } from "../dist/runtime/shim.js";

const TAG = `<script src="/${SHIM_FILENAME}"></script>`;

function pages(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "shim-inject-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, html] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), html);
  }
  return dir;
}

const doctypeFirst = (html) => /^(?:\uFEFF)?(?:\s|<!--[\s\S]*?-->)*<!doctype html>/i.test(html);

test("the shim becomes the first script of every extension page, nested ones included", (t) => {
  const dir = pages(t, {
    "popup.html": '<!doctype html><html><head><script src="vendor.js"></script></head><body></body></html>',
    "pages/options/index.html": "<html><head><title>x</title></head><body><script src=app.js></script></body></html>",
  });
  assert.equal(injectShimIntoHtmlPages(dir, SHIM_FILENAME), 2);
  const popup = readFileSync(join(dir, "popup.html"), "utf-8");
  assert.ok(popup.indexOf(TAG) >= 0 && popup.indexOf(TAG) < popup.indexOf("vendor.js"), popup);
  const options = readFileSync(join(dir, "pages/options/index.html"), "utf-8");
  assert.ok(options.includes(TAG), "root-absolute src works from any depth");
});

test("running it again changes nothing", (t) => {
  const dir = pages(t, { "a.html": "<head></head>" });
  injectShimIntoHtmlPages(dir, SHIM_FILENAME);
  const once = readFileSync(join(dir, "a.html"), "utf-8");
  assert.equal(injectShimIntoHtmlPages(dir, SHIM_FILENAME), 0);
  assert.equal(readFileSync(join(dir, "a.html"), "utf-8"), once);
});

test("a page without a head keeps its doctype first, so it stays in standards mode", (t) => {
  const dir = pages(t, { "install.html": '<!DOCTYPE html>\n<meta charset="utf-8">\n<body><script src="app.js"></script>' });
  injectShimIntoHtmlPages(dir, SHIM_FILENAME);
  const html = readFileSync(join(dir, "install.html"), "utf-8");
  assert.ok(doctypeFirst(html), html.slice(0, 120));
  assert.ok(html.indexOf(TAG) < html.indexOf("app.js"));
});

test("a commented-out head is skipped", (t) => {
  const dir = pages(t, { "p.html": "<!-- <head> old --><html><head><script src=a.js></script></head></html>" });
  injectShimIntoHtmlPages(dir, SHIM_FILENAME);
  const html = readFileSync(join(dir, "p.html"), "utf-8");
  assert.ok(html.indexOf(TAG) > html.indexOf("-->"), "a script inside the comment would never run");
});
