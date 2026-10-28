import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanExtension } from "../dist/analyze/analyze.js";

function makeExtension(files) {
  const dir = mkdtempSync(join(tmpdir(), "analyze-scan-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const MIN = { minFirefox: "153.0" };

test("a chrome.offscreen call is reported as shimmed, not blocking", (t) => {
  const manifest = { manifest_version: 3, name: "Off", version: "1", background: { service_worker: "background.js" } };
  const dir = makeExtension({
    "background.js": 'chrome.offscreen.createDocument({ url: "off.html", reasons: ["DOM_PARSER"], justification: "x" });\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const issues = scanExtension(dir, manifest, MIN);
  const offscreen = issues.filter((i) => i.category === "api" && i.file === "background.js");
  assert.equal(offscreen.length, 1, JSON.stringify(issues));
  assert.equal(offscreen[0].shimmed, true);
  assert.notEqual(offscreen[0].severity, "error");
});

test("a content script missing from the package is an error", (t) => {
  const manifest = {
    manifest_version: 3,
    name: "Missing",
    version: "1",
    content_scripts: [{ matches: ["<all_urls>"], js: ["present.js", "gone.js"] }],
  };
  const dir = makeExtension({ "present.js": "console.log(1);\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const errors = scanExtension(dir, manifest, MIN).filter((i) => i.severity === "error");
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0].category, "manifest");
  assert.match(errors[0].message, /content_scripts\[0\]\.js references "gone\.js"/);
});

test("a blocking-webRequest ad blocker converts without a blocking issue", (t) => {
  // Firefox honours blocking webRequest, so the content-blocker error and the
  // blocking-webRequest warning must not fire.
  const manifest = {
    manifest_version: 2,
    name: "Blocker",
    version: "1",
    permissions: ["webRequest", "webRequestBlocking", "<all_urls>"],
    background: { scripts: ["bg.js"] },
  };
  const dir = makeExtension({
    "bg.js": 'chrome.webRequest.onBeforeRequest.addListener(() => ({ cancel: true }), { urls: ["<all_urls>"] }, ["blocking"]);\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const issues = scanExtension(dir, manifest, MIN);
  assert.deepEqual(issues.filter((i) => i.severity !== "info"), []);
});

test("an SVG icon is accepted, but a missing icon is an error", (t) => {
  const manifest = { manifest_version: 3, name: "Icons", version: "1", icons: { 48: "icon.svg", 128: "icon128.png" } };
  const dir = makeExtension({ "icon.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const issues = scanExtension(dir, manifest, MIN);
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0].severity, "error");
  assert.match(issues[0].message, /icon128\.png/);
});

test("main-world script injection warns only when the minimum Firefox is below 128", (t) => {
  const manifest = { manifest_version: 3, name: "Main", version: "1", background: { service_worker: "sw.js" } };
  const dir = makeExtension({
    "sw.js": 'chrome.scripting.executeScript({ target: { tabId: 1 }, world: "MAIN", func: () => 1 });\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const mainWorld = (opts) => scanExtension(dir, manifest, opts).filter((i) => /world: "MAIN"/.test(i.message));
  assert.equal(mainWorld({ minFirefox: "127.0" }).length, 1);
  assert.equal(mainWorld({ minFirefox: "128.0" }).length, 0);
});

test("hardcoded extension ids and chrome:// pages are flagged, bare chrome:// prefix checks are not", (t) => {
  const manifest = { manifest_version: 3, name: "Urls", version: "1", action: { default_popup: "popup.html" } };
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const dir = makeExtension({
    "popup.html": "<!doctype html><script src=popup.js></script>",
    "popup.js": [
      'if (url.startsWith("chrome://")) skip();',
      `fetch("chrome-extension://${id}/data.json");`,
      'chrome.tabs.create({ url: "chrome://extensions/shortcuts" });',
      "",
    ].join("\n"),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const issues = scanExtension(dir, manifest, MIN);
  const ext = issues.find((i) => /chrome-extension:\/\/<id>/.test(i.message));
  assert.ok(ext, JSON.stringify(issues));
  assert.equal(ext.line, 2);
  const page = issues.find((i) => /chrome:\/\/ pages/.test(i.message));
  assert.ok(page, JSON.stringify(issues));
  assert.equal(page.line, 3);
  assert.match(page.message, /chrome:\/\/extensions\/shortcuts/);
});

test("importScripts in a classic worker is auto-hoisted, in a module worker it is not claimed", (t) => {
  const dir = makeExtension({ "sw.js": 'importScripts("a.js");\n', "a.js": "self.a = 1;\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const classic = { manifest_version: 3, name: "W", version: "1", background: { service_worker: "sw.js" } };
  const hoisted = scanExtension(dir, classic, MIN).filter((i) => i.category === "background");
  assert.equal(hoisted.length, 1);
  assert.equal(hoisted[0].severity, "info");
  assert.match(hoisted[0].message, /background\.scripts/);

  const module = { ...classic, background: { service_worker: "sw.js", type: "module" } };
  assert.deepEqual(scanExtension(dir, module, MIN).filter((i) => i.category === "background"), []);
});

test("an API Firefox already has at the minimum version isn't reported", (t) => {
  const manifest = { manifest_version: 3, name: "Gates", version: "1", background: { service_worker: "sw.js" } };
  const dir = makeExtension({
    "sw.js": "chrome.storage.session.get('k');\nchrome.tabGroups.query({});\nchrome.runtime.getVersion();\n",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gates = (minFirefox) =>
    scanExtension(dir, manifest, { minFirefox }).filter((i) => /needs Firefox/.test(i.message)).map((i) => i.message.match(/chrome\.[\w.]+/)[0]);

  // storage.session is from 115 and tabGroups from 139: both there in 153.
  assert.deepEqual(gates("153.0"), ["chrome.runtime.getVersion"]);
  assert.deepEqual(gates("128.0").sort(), ["chrome.runtime.getVersion", "chrome.tabGroups"]);
  assert.deepEqual(gates("158"), []);
});
