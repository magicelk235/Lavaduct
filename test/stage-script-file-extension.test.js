// Firefox runs a moz-extension: file as a script only when its name ends in .js,
// .mjs or .jsm (MV3 add-ons; nsContentSecurityManager refuses the rest with "the
// file extension is not allowed"). Chrome runs any name: Save to Google Drive's
// options page loads js/rpc.js.compiled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { applySourceRewrites } from "../dist/input/stage.js";
import { firefox, loadAddon } from "./firefox-load.js";

const report = (name) => `browser.runtime.sendMessage({ loaded: ${JSON.stringify(name)} });`;

function extension() {
  return {
    manifest: {
      manifest_version: 3,
      name: "Odd script names",
      version: "1",
      browser_specific_settings: { gecko: { id: "odd-script-names@example.com" } },
      background: { scripts: ["bg.js", "lib/util.js.compiled"] },
      content_scripts: [{ matches: ["<all_urls>"], js: ["cs.compiled"] }],
    },
    files: {
      "bg.js": `
        const loaded = new Set();
        const injectStyle = (tabId) => browser.scripting.insertCSS({ target: { tabId }, files: ["style.css"] });
        browser.runtime.onMessage.addListener((m) => { if (m && m.loaded) loaded.add(m.loaded); });
        const worker = new Worker("work/w.js.compiled");
        worker.onmessage = (e) => loaded.add(e.data);
        const frame = document.createElement("iframe");
        frame.src = "options.html";
        document.body.appendChild(frame);
        setTimeout(() => {
          if (globalThis.UTIL === 1) loaded.add("background script");
          browser.tabs.create({ url: "done.html#" + [...loaded].sort().join(",") });
        }, 2500);
      `,
      "lib/util.js.compiled": "globalThis.UTIL = 1;",
      "cs.compiled": "void 0;",
      "work/w.js.compiled": 'importScripts("dep.js.compiled"); postMessage(self.DEP);',
      "work/dep.js.compiled": 'self.DEP = "importScripts in a worker";',
      "options.html": '<!doctype html><script src="js/rpc.js.compiled?v=3"></script><script type=module src="./js/mod.mjs"></script><script type="text/template" src="tpl.x"></script>',
      "js/rpc.js.compiled": report("page script"),
      "js/mod.mjs": 'import "./dyn.esm"; import data from "./data.json" with { type: "json" };',
      "js/dyn.esm": report("module import"),
      "js/data.json": "{}",
      "tpl.x": "not a script",
      "style.css": "body{}",
      "mention.js": 'fetch(chrome.runtime.getURL("lib/util.js.compiled"));',
      "done.html": "<!doctype html>",
    },
  };
}

function stage({ manifest, files }) {
  const dir = mkdtempSync(join(tmpdir(), "stage-script-ext-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  applySourceRewrites(dir, manifest);
  return dir;
}

function readTree(dir, rel = "", out = {}) {
  for (const name of readdirSync(join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, r)).isDirectory()) readTree(dir, r, out);
    else out[r] = readFileSync(join(dir, r), "utf-8");
  }
  return out;
}

test("scripts named without .js get a .js name and their references follow", () => {
  const ext = extension();
  const dir = stage(ext);
  try {
    assert.deepEqual(ext.manifest.background.scripts, ["bg.js", "lib/util.js.compiled.js"]);
    assert.deepEqual(ext.manifest.content_scripts[0].js, ["cs.compiled.js"]);
    const options = readFileSync(join(dir, "options.html"), "utf-8");
    assert.match(options, /src="js\/rpc\.js\.compiled\.js\?v=3"/);
    assert.match(options, /src="tpl\.x"/, "a non-JS script type isn't loaded, so it keeps its name");
    assert.match(readFileSync(join(dir, "bg.js"), "utf-8"), /new Worker\("work\/w\.js\.compiled\.js"\)/);
    assert.match(readFileSync(join(dir, "work/w.js.compiled.js"), "utf-8"), /importScripts\("dep\.js\.compiled\.js"\)/);
    const mod = readFileSync(join(dir, "js/mod.mjs"), "utf-8");
    assert.match(mod, /import "\.\/dyn\.esm\.js"/);
    assert.match(mod, /from "\.\/data\.json"/, "a JSON module isn't a script");
    // Originals go unless something still names them.
    assert.ok(!existsSync(join(dir, "js/rpc.js.compiled")));
    assert.ok(!existsSync(join(dir, "cs.compiled")));
    assert.ok(existsSync(join(dir, "lib/util.js.compiled")), "still fetched through getURL");
    assert.ok(existsSync(join(dir, "js/data.json")) && existsSync(join(dir, "tpl.x")));
    assert.match(readFileSync(join(dir, "bg.js"), "utf-8"), /files: \["style\.css"\]/, "insertCSS files are stylesheets");
    assert.ok(existsSync(join(dir, "style.css")) && !existsSync(join(dir, "style.css.js")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an MV2 add-on is left alone: Firefox only checks MV3 script names", () => {
  const ext = extension();
  ext.manifest.manifest_version = 2;
  const dir = stage(ext);
  try {
    assert.deepEqual(ext.manifest.background.scripts, ["bg.js", "lib/util.js.compiled"]);
    assert.match(readFileSync(join(dir, "options.html"), "utf-8"), /src="js\/rpc\.js\.compiled\?v=3"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Firefox runs every renamed script", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  const ext = extension();
  const dir = stage(ext);
  let files;
  try {
    files = readTree(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const loaded = await loadAddon(ext.manifest, files, async ({ chrome }) => {
    for (let i = 0; i < 150; i++) {
      const spec = await chrome(`(() => {
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        const tab = win.gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec.includes("done.html#"));
        return tab ? tab.linkedBrowser.currentURI.spec : "";
      })()`);
      if (spec) return decodeURIComponent(spec.split("#")[1]).split(",");
      await sleep(100);
    }
    return "timed out";
  });
  assert.deepEqual(loaded, ["background script", "importScripts in a worker", "module import", "page script"]);
});
