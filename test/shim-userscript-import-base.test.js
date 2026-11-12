import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";

// Chrome gives each code entry of a registered user script a URL inside the
// extension (chrome-extension://<id>/<random UUID>; Chromium's
// extensions/common/utils/content_script_utils.cc ParseFileSources), so a
// relative dynamic import in it loads the extension's file. Firefox 160
// resolves it against the page: Surfingkeys 1.19.3 wraps every snippet in
// `import('./api.js')`, which asked https://example.com/api.js (refused by the
// world's CSP) and its snippets never ran.

function setup() {
  const browser = fakeBrowser();
  const registered = [];
  const executed = [];
  browser.permissions = { onAdded: { addListener() {} } };
  browser.userScripts = {
    register: (scripts) => { registered.push(...structuredClone(scripts)); return Promise.resolve(); },
    update: (scripts) => {
      for (const s of structuredClone(scripts)) registered[registered.findIndex((r) => r.id === s.id)] = s;
      return Promise.resolve();
    },
    execute: (injection) => { executed.push(structuredClone(injection)); return Promise.resolve([]); },
    getScripts: () => Promise.resolve(structuredClone(registered)),
  };
  const ctx = runInContext(buildShim({ userScripts: true }), { browser });
  return { ctx, registered, executed };
}

const SNIPPET = "import('./api.js').then((module) => {module.default(\"x\", (api, settings) => {})});";

// The code Firefox runs, after the shim's prelude.
const userCode = (script) => script.js[script.js.length - 1].code;

test("a relative or root-relative import() in registered user-script code loads the add-on's file, as in Chrome", async () => {
  const { ctx, registered } = setup();
  const code = [
    SNIPPET,
    "import( '/lib/a.mjs?v=2#x' ); import(`../b.js`);",
    "import(\"./dir/../c.js\"); import('https://cdn.test/d.js'); import('//cdn.test/e.js'); import(name); import('lodash'); obj.import('./f.js');",
  ].join("\n");
  await vm.runInContext(`chrome.userScripts.register([{ id: "s", matches: ["*://*/*"], js: [{ code: ${JSON.stringify(code)} }, { file: "u.js" }] }])`, ctx);
  const ran = registered[0].js.find((e) => e.code && e.code.includes("module.default")).code;
  assert.doesNotThrow(() => new Function("obj", "name", ran), "the rewritten code still parses");
  // What the registered code imports, once Firefox runs it.
  const imports = [...ran.matchAll(/(?:^|[^\w$.])import\s*\(\s*(?:\/\*[\s\S]*?\*\/)?\s*("[^"]*"|'[^']*'|`[^`]*`|\w+)/g)].map((m) => m[1]);
  assert.deepEqual(imports, [
    JSON.stringify(`${EXT_ORIGIN}/api.js`),
    JSON.stringify(`${EXT_ORIGIN}/lib/a.mjs?v=2#x`),
    JSON.stringify(`${EXT_ORIGIN}/b.js`),
    JSON.stringify(`${EXT_ORIGIN}/c.js`),
    "'https://cdn.test/d.js'",
    "'//cdn.test/e.js'",
    "name",
    "'lodash'",
  ]);
  assert.match(ran, /obj\.import\('\.\/f\.js'\)/, "a method named import is left alone");
  assert.deepEqual(plain(registered[0].js.at(-1)), { file: "u.js" }, "file entries stay as they are");

  // getScripts reports the code as registered, which Surfingkeys compares
  // against its snippet before deciding to register it again.
  const listed = plain(await vm.runInContext("chrome.userScripts.getScripts()", ctx));
  assert.deepEqual(listed[0].js, [{ code }, { file: "u.js" }]);
  const viaCallback = await vm.runInContext("new Promise((r) => chrome.userScripts.getScripts({ ids: ['s'] }, r))", ctx);
  assert.equal(plain(viaCallback)[0].js[0].code, code);
});

test("userScripts.update resolves the same way; execute, whose code Chrome gives no URL, doesn't", async () => {
  const { ctx, registered, executed } = setup();
  await vm.runInContext(`chrome.userScripts.register([{ id: "s", matches: ["*://*/*"], js: [{ code: "1" }] }])`, ctx);
  await vm.runInContext(`chrome.userScripts.update([{ id: "s", js: [{ code: ${JSON.stringify(SNIPPET)} }] }])`, ctx);
  assert.match(userCode(registered[0]), new RegExp(`"${EXT_ORIGIN}/api\\.js"`));
  await vm.runInContext(`chrome.userScripts.execute({ target: { tabId: 1 }, js: [{ code: ${JSON.stringify(SNIPPET)} }] })`, ctx);
  assert.equal(userCode(executed[0]), SNIPPET);
});
