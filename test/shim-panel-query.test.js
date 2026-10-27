import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { derivePanelWindowQuery } from "../dist/runtime/shim.js";

// An extension that also opens its side-panel page as a standalone window says
// how the page behaves outside Chrome's docked panel:
//   windows.create({ url: getURL(`sidepanel.html?mode=window&sessionId=${id}`) })
// The derived query goes onto the sidebar page. Only the literal head of the URL
// counts, and only complete key=value pairs in it.

function bundle(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "panel-query-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "assets"));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  return dir;
}
const manifest = { manifest_version: 3, side_panel: { default_path: "sidepanel.html" } };

test("the window-mode head is derived; dynamic tails and a permission popup are not", (t) => {
  const dir = bundle(t, {
    "assets/sw.js": 'const i=chrome.runtime.getURL(`sidepanel.html?mode=window&sessionId=${t}${n?"&skipPermissions=true":""}`),o=await chrome.windows.create({url:i,type:"popup",width:500});',
    "assets/ui.js": 'chrome.windows.create({url:chrome.runtime.getURL(`sidepanel.html?tabId=${t}&mcpPermissionOnly=true&requestId=${r}`),type:"popup"},e=>{});' +
      'const j=chrome.runtime.getURL(`sidepanel.html?mode=window&sessionId=${t}`);chrome.windows.create({url:j});',
  });
  assert.equal(derivePanelWindowQuery(dir, manifest), "mode=window");
});

test("a bundle that never opens its panel as a window yields nothing", (t) => {
  const dir = bundle(t, {
    "assets/sw.js": 'chrome.sidePanel.setOptions({path:`sidepanel.html?tabId=${e}`});chrome.tabs.create({url:"sidepanel.html?mode=tab"});',
  });
  assert.equal(derivePanelWindowQuery(dir, manifest), "");
});

test("a bundle whose window forms disagree yields nothing, even on a majority", (t) => {
  const dir = bundle(t, {
    "assets/a.js": 'chrome.windows.create({url:chrome.runtime.getURL("sidepanel.html?mode=window")});' +
      'chrome.windows.create({url:chrome.runtime.getURL("sidepanel.html?mode=window")});',
    "assets/b.js": 'chrome.windows.create({url:chrome.runtime.getURL("sidepanel.html?mode=compact")});',
  });
  assert.equal(derivePanelWindowQuery(dir, manifest), "");
});

test("the literal nearest the call wins over a setOptions path in the same stretch of code", (t) => {
  const dir = bundle(t, {
    "assets/sw.js": 'chrome.sidePanel.setOptions({tabId:e,path:`sidepanel.html?tabId=${encodeURIComponent(e)}`,enabled:!0});' +
      "x".repeat(200) + ';const i=chrome.runtime.getURL(`sidepanel.html?mode=window&sessionId=${t}`);const o=await chrome.windows.create({url:i,type:"popup"});',
  });
  assert.equal(derivePanelWindowQuery(dir, manifest), "mode=window");
});

test("a declared side_panel path in a subdirectory is matched exactly", (t) => {
  const dir = bundle(t, {
    "assets/sw.js": 'chrome.windows.create({url:chrome.runtime.getURL("panel/index.html?standalone=1&x=y")});' +
      'chrome.windows.create({url:chrome.runtime.getURL("settings/index.html?mode=window")});',
  });
  assert.equal(derivePanelWindowQuery(dir, { manifest_version: 3, side_panel: { default_path: "/panel/index.html" } }), "standalone=1&x=y");
});

test("with no side_panel key a `sidepanel` page name still counts, any other page does not", (t) => {
  const dir = bundle(t, {
    "assets/sw.js": 'chrome.windows.create({url:chrome.runtime.getURL(`sidepanel.html?mode=window&sessionId=${t}`)});',
    "assets/other.js": 'chrome.windows.create({url:"popup.html?mode=window"});',
  });
  assert.equal(derivePanelWindowQuery(dir, { manifest_version: 3 }), "mode=window");
  const dir2 = bundle(t, { "assets/sw.js": 'chrome.windows.create({url:"popup.html?mode=window"});' });
  assert.equal(derivePanelWindowQuery(dir2, { manifest_version: 3 }), "");
});
