import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectShimIntoHtmlPages, SHIM_FILENAME } from "../dist/runtime/shim.js";

// The shim's <script> goes into every extension page. A page saved in a
// charset other than UTF-8 must keep its bytes: decoding it as UTF-8 and
// writing it back turned every non-ASCII character into U+FFFD.

const TAG = `<script src="/${SHIM_FILENAME}"></script>`;

function dirWith(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "shim-inject-enc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return dir;
}

test("a windows-1252 page keeps its bytes when the shim is injected", (t) => {
  const head = Buffer.from('<html><head><meta charset="windows-1252"></head><body>caf');
  const tail = Buffer.from("</body></html>");
  const dir = dirWith(t, { "page.html": Buffer.concat([head, Buffer.from([0xe9]), tail]) });
  assert.equal(injectShimIntoHtmlPages(dir, SHIM_FILENAME), 1);
  const out = readFileSync(join(dir, "page.html"));
  assert.ok(out.includes(Buffer.from(TAG)));
  assert.ok(out.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x3c])), "the é byte (0xE9) is still there, not EF BF BD");
});

test("a UTF-8 page keeps its characters and a BOM ahead of its doctype", (t) => {
  const dir = dirWith(t, { "p.html": "\uFEFF<!doctype html>\n<body>h\u00e9llo \u2603<script src=a.js></script>" });
  injectShimIntoHtmlPages(dir, SHIM_FILENAME);
  const html = readFileSync(join(dir, "p.html"), "utf-8");
  assert.ok(html.startsWith("\uFEFF<!doctype html>\n" + TAG), JSON.stringify(html.slice(0, 80)));
  assert.ok(html.includes("h\u00e9llo \u2603"));
});
