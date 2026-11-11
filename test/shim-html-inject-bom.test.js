import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectShimIntoHtmlPages, insertAtHeadStart, SHIM_FILENAME } from "../dist/runtime/shim.js";

// A page with neither <head> nor doctype gets the shim's <script> at its top.
// Its UTF-8 byte order mark has to stay the first thing in the file: a BOM
// anywhere else is a stray character in the body, and the page loses the
// only thing that told Firefox it is UTF-8.

const TAG = `<script src="/${SHIM_FILENAME}"></script>`;

test("a byte order mark stays first in a page without head or doctype", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shim-inject-bom-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "popup.html"), "\uFEFF<p>h\u00e9llo</p><script src=popup.js></script>");
  injectShimIntoHtmlPages(dir, SHIM_FILENAME);
  const bytes = readFileSync(join(dir, "popup.html"));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.indexOf(Buffer.from([0xef, 0xbb, 0xbf]), 3), -1, "no second BOM further in");
  assert.ok(bytes.toString("utf-8").startsWith("\uFEFF" + TAG));
});

test("insertAtHeadStart keeps a decoded BOM first too", () => {
  assert.equal(insertAtHeadStart("\uFEFF<p>x</p>", "<s>"), "\uFEFF<s>\n<p>x</p>");
});
