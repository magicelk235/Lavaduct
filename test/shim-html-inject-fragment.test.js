import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectShimIntoHtmlPages, SHIM_FILENAME } from "../dist/runtime/shim.js";

// Add-ons ship HTML fragments they fetch and insert with innerHTML or
// insertAdjacentHTML (a list row, a dialog's markup). Such a file is no page:
// a <script> put at its top lands in the add-on's DOM as the fragment's first
// element, and code reading `firstElementChild` gets the script instead.

const TAG = `<script src="/${SHIM_FILENAME}"></script>`;

test("an HTML fragment without doctype, html, head, body or script is left alone", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shim-inject-frag-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const row = '<li class="row"><span class="name"></span></li>\n';
  writeFileSync(join(dir, "row.html"), row);
  writeFileSync(join(dir, "popup.html"), '<div id="app"></div><script src="popup.js"></script>');
  assert.equal(injectShimIntoHtmlPages(dir, SHIM_FILENAME), 1);
  assert.equal(readFileSync(join(dir, "row.html"), "utf-8"), row);
  assert.ok(readFileSync(join(dir, "popup.html"), "utf-8").startsWith(TAG), "a page that runs a script still gets the shim");
});
