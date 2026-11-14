import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySourceRewrites, stageExtension } from "../dist/input/stage.js";

function stageWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "input-stage-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test("chrome-extension: scheme literals become moz-extension:", () => {
  const dir = stageWith({
    "bg.js": 'if (sender.url.startsWith("chrome-extension://")) ok();\nconst P = ["chrome-extension:"];',
    "content.css": "@font-face { src: url(chrome-extension://__MSG_@@extension_id__/f.woff2); }",
  });
  const counts = applySourceRewrites(dir, { manifest_version: 3, name: "T", version: "1" });
  const js = readFileSync(join(dir, "bg.js"), "utf-8");
  assert.ok(!js.includes("chrome-extension:"));
  assert.match(js, /startsWith\("moz-extension:\/\/"\)/);
  assert.match(js, /\["moz-extension:"\]/);
  assert.equal(readFileSync(join(dir, "content.css"), "utf-8"), "@font-face { src: url(moz-extension://__MSG_@@extension_id__/f.woff2); }");
  assert.ok(counts.find((c) => c.name.includes("scheme literals")).count >= 1);
});

test("a concrete-host OAuth redirect URI is left alone", () => {
  const uri = "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html";
  const dir = stageWith({ "auth.js": `const redirect_uri = "${uri}";` });
  applySourceRewrites(dir, { manifest_version: 3, name: "T", version: "1" });
  assert.equal(readFileSync(join(dir, "auth.js"), "utf-8"), `const redirect_uri = "${uri}";`);
});

test("self-page URLs built from runtime.id go through runtime.getURL", () => {
  const dir = stageWith({ "bg.js": "chrome.tabs.create({ url: `chrome-extension://${chrome.runtime.id}/options.html` });" });
  applySourceRewrites(dir, { manifest_version: 3, name: "T", version: "1" });
  assert.equal(
    readFileSync(join(dir, "bg.js"), "utf-8"),
    "chrome.tabs.create({ url: chrome.runtime.getURL(`options.html`) });",
  );
});

test("the background's own window check answers 'background'", () => {
  const dir = stageWith({
    "sw.js": 'function ctx(){ if (typeof window === "undefined") return "background"; return "content"; }',
    "popup.js": 'function ctx(){ if (typeof window === "undefined") return "background"; return "content"; }',
  });
  applySourceRewrites(dir, { manifest_version: 3, name: "T", version: "1", background: { service_worker: "sw.js" } });
  // Both run in a page that has a window, as Firefox background scripts do.
  const run = (rel) => new Function("window", readFileSync(join(dir, rel), "utf-8") + "; return ctx();")({});
  assert.equal(run("sw.js"), "background");
  assert.equal(run("popup.js"), "content");
});

test("a worker's self.window alias goes, since an event page's window can't be assigned", () => {
  const code = '"use strict";var a=self.window||0;self.window=self;start(),globalThis.window = globalThis;x.self.window=self;';
  const dir = stageWith({ "sw.js": code, "page.js": code });
  applySourceRewrites(dir, { manifest_version: 3, name: "T", version: "1", background: { service_worker: "sw.js" } });
  assert.equal(readFileSync(join(dir, "sw.js"), "utf-8"), '"use strict";var a=self.window||0;self;start(),globalThis;(x.self===globalThis?{}:x.self).window=self;');
  assert.equal(readFileSync(join(dir, "page.js"), "utf-8"), code, "only the background's own scripts change");
});

test("staging drops dev cruft and symlinks but keeps manifest-referenced files", () => {
  const src = stageWith({
    "manifest.json": "{}",
    "bg.js": "1",
    "README.md": "x",
    "LICENSE.txt": "mit",
    "node_modules/x/index.js": "x",
  });
  symlinkSync("/etc/hosts", join(src, "hosts"));
  const stage = join(mkdtempSync(join(tmpdir(), "input-stage-out-")), "stage");
  const dropped = stageExtension(src, stage, new Set(["LICENSE.txt"]));
  assert.deepEqual(dropped, []);
  assert.ok(existsSync(join(stage, "bg.js")));
  assert.ok(existsSync(join(stage, "LICENSE.txt")));
  assert.ok(!existsSync(join(stage, "README.md")));
  assert.ok(!existsSync(join(stage, "node_modules")));
  assert.ok(!existsSync(join(stage, "hosts")));
});

test('Function("return this")() global lookups become globalThis, which content-script CSP allows', () => {
  const code = 'var a=f||s||Function("return this")();var b=new Function(\'return this;\')();var c=w.Function("return this")();var d=Function("return this");';
  const dir = stageWith({ "lib.js": code });
  applySourceRewrites(dir, { manifest_version: 3, name: "T", version: "1" });
  assert.equal(readFileSync(join(dir, "lib.js"), "utf-8"), 'var a=f||s||globalThis;var b=globalThis;var c=w.Function("return this")();var d=Function("return this");');
});
