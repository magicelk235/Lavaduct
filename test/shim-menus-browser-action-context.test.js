import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// Chrome's contextMenus takes "browser_action" from an MV3 extension and keeps
// the item, showing it everywhere else its contexts say. Firefox's menus schema
// offers "browser_action" to MV2 only, so an MV3 add-on's create() throws a
// TypeError and the whole item is lost, its page and selection contexts too.
// Immersive Translate sniffs the user agent, takes its Firefox branch, and asks
// for ["page", "frame", "selection", "browser_action", "page_action"]: every
// one of its menus was refused in Firefox 159 and 160. MV3's name for the
// toolbar button's menu is "action".

const MENU_CONTEXTS = new Set(["all", "page", "frame", "selection", "link", "editable", "password", "image", "video", "audio", "launcher", "bookmark", "page_action", "tab", "tools_menu", "action"]);

function firefoxMenus() {
  const items = new Map();
  function check(contexts) {
    for (const [i, c] of (contexts ?? []).entries()) {
      if (!MENU_CONTEXTS.has(c)) throw new TypeError(`Type error for parameter createProperties (Error processing contexts.${i}: Value "${c}" must either: be one of [...], or be one of ["action"]) for contextMenus.create.`);
    }
  }
  return {
    items,
    create(props, cb) { check(props.contexts); items.set(props.id, { ...props }); if (cb) cb(); return props.id; },
    update(id, props) { check(props.contexts); Object.assign(items.get(id), props); return Promise.resolve(); },
    remove(id) { items.delete(id); return Promise.resolve(); },
  };
}

function setup(code, manifestVersion = 3) {
  const browser = fakeBrowser({ manifest: { manifest_version: manifestVersion, name: "T", version: "1" } });
  browser.menus = firefoxMenus();
  browser.contextMenus = firefoxMenus();
  const native = { create: browser.contextMenus.create, update: browser.contextMenus.update };
  const ctx = runInContext(buildShim({}, { "bg.js": code }), { browser });
  return { browser, ctx, native };
}

const BUNDLE = 'var ctx = isChrome() ? ["action"] : ["browser_action", "page_action"];';

test('an MV3 menu item asking for the "browser_action" context is created on the toolbar button\'s "action" menu', () => {
  const { browser, ctx } = setup(BUNDLE);
  vm.runInContext(`
    globalThis.props = { id: "toggle", title: "Translate", contexts: ["page", "frame", "selection", "browser_action", "page_action"] };
    globalThis.created = chrome.contextMenus.create(props, () => { globalThis.done = true; });
    browser.menus.create({ id: "opts", title: "Options", contexts: ["browser_action", "action"] });
  `, ctx);
  assert.equal(ctx.created, "toggle");
  assert.equal(ctx.done, true, "the callback still runs");
  assert.deepEqual([...browser.contextMenus.items.get("toggle").contexts], ["page", "frame", "selection", "action", "page_action"]);
  assert.deepEqual([...browser.menus.items.get("opts").contexts], ["action"], "named both ways, the context is kept once");
  assert.deepEqual([...ctx.props.contexts], ["page", "frame", "selection", "browser_action", "page_action"], "the add-on's object is left alone");
});

test('update() with the "browser_action" context reaches Firefox as "action"', async () => {
  const { browser, ctx } = setup(BUNDLE);
  await vm.runInContext(`
    chrome.contextMenus.create({ id: "pdf", title: "PDF", contexts: ["action"] });
    chrome.contextMenus.update("pdf", { contexts: ["browser_action"], title: "PDF file" });
  `, ctx);
  assert.deepEqual([...browser.contextMenus.items.get("pdf").contexts], ["action"]);
  assert.equal(browser.contextMenus.items.get("pdf").title, "PDF file");
});

test("an MV2 add-on and a bundle that never names browser_action keep Firefox's own menus", () => {
  const mv2 = setup(BUNDLE, 2);
  assert.equal(mv2.browser.contextMenus.create, mv2.native.create);
  const plain = setup('chrome.contextMenus.create({ id: "x", contexts: ["page"] });');
  assert.equal(plain.browser.contextMenus.create, plain.native.create);
  assert.equal(plain.browser.contextMenus.update, plain.native.update);
});
