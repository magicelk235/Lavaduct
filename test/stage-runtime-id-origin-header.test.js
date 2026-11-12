import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySourceRewrites } from "../dist/input/stage.js";

const MANIFEST = { manifest_version: 3, name: "T", version: "1" };
const CHROME_ID = "mgijmajocgfcbeboacabfgobmjgjcoja";

function rewrite(t, src, chromeId = CHROME_ID) {
  const dir = mkdtempSync(join(tmpdir(), "stage-origin-header-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bg.js"), src);
  applySourceRewrites(dir, MANIFEST, chromeId);
  return readFileSync(join(dir, "bg.js"), "utf-8");
}

// Google Dictionary names itself to its API with
//   fetch(url, { headers: { "x-referer": "chrome-extension://" + chrome.runtime.id } })
// and the API key only accepts its Chrome origin. The origin rewrite meant for
// comparisons with sender URLs turned the header into the moz-extension origin,
// and Google answered 403 "Requests from referer moz-extension://… are blocked".
test("a runtime.id origin sent as a referer header is the Chrome origin", (t) => {
  const origin = `"chrome-extension://${CHROME_ID}"`;
  assert.equal(
    rewrite(t, 'fetch(u,{headers:{"x-referer":"chrome-extension://"+chrome.runtime.id}})'),
    `fetch(u,{headers:{"x-referer":${origin}}})`,
  );
  assert.equal(rewrite(t, "h = { 'Referer': `chrome-extension://${browser.runtime.id}` };"), `h = { 'Referer': ${origin} };`);
  assert.equal(
    rewrite(t, 'headers.set("X-Referer", "chrome-extension://" + chrome.runtime.id); xhr.setRequestHeader("x-referrer", `chrome-extension://${chrome.runtime.id}`);'),
    `headers.set("X-Referer", ${origin}); xhr.setRequestHeader("x-referrer", ${origin});`,
  );
});

test("an origin compared with a sender, or a fetch init referrer, still becomes the add-on's own origin", (t) => {
  const own = 'new URL(chrome.runtime.getURL("/")).origin';
  assert.equal(rewrite(t, 'if (sender.origin === "chrome-extension://" + chrome.runtime.id) ok();'), `if (sender.origin === ${own}) ok();`);
  assert.equal(rewrite(t, 'fetch(u, { referrer: "chrome-extension://" + chrome.runtime.id });'), `fetch(u, { referrer: ${own} });`);
});

test("without a Chrome ID a referer header keeps the add-on's own origin", (t) => {
  assert.equal(
    rewrite(t, '({"x-referer":"chrome-extension://"+chrome.runtime.id})', ""),
    '({"x-referer":new URL(chrome.runtime.getURL("/")).origin})',
  );
});
