import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// A Firefox content script's Response is the page's, so json() builds its
// objects in the page's realm and Object.getPrototypeOf(value) is not the
// script's Object.prototype. Chrome's isolated world gets its own objects.
// Immersive Translate merges rules only from objects whose prototype is
// Object.prototype, and in Firefox dropped every nested rule. Measured in
// Firefox 160 by test/firefox-content-json-realm.test.js; here the page is a
// second vm realm.

function pageRealm() {
  return vm.runInNewContext(`
    class Body {
      constructor(text) { this._text = text; this.bodyUsed = false; }
      text() {
        if (this.bodyUsed) return Promise.reject(new TypeError("Body has already been consumed."));
        this.bodyUsed = true;
        return Promise.resolve(this._text);
      }
      json() { return this.text().then((t) => JSON.parse(t)); }
    }
    class Response extends Body {}
    class Request extends Body {}
    ({ Response, Request });
  `);
}

const CODE = "fetch(url).then((r) => r.json());";

function contentScript(code = CODE) {
  const page = pageRealm();
  const browser = fakeBrowser();
  const windowXray = {};
  const ctx = runInContext(buildShim({}, { "cs.js": code }), {
    browser, href: "https://example.com/", globals: { window: windowXray, Response: page.Response, Request: page.Request },
  });
  return { ctx, page };
}

test("json() in a content script gives objects of the script's own realm", async () => {
  const { ctx } = contentScript();
  const out = await vm.runInContext(`(async () => {
    const v = await new Response('{"rule":{"a":1},"list":[1]}').json();
    return [Object.getPrototypeOf(v) === Object.prototype, Object.getPrototypeOf(v.rule) === Object.prototype, v.list instanceof Array, v.rule.a];
  })()`, ctx);
  assert.deepEqual([...out], [true, true, true, 1]);
  const req = await vm.runInContext(`new Request('{"x":{}}').json().then((v) => Object.getPrototypeOf(v.x) === Object.prototype)`, ctx);
  assert.equal(req, true);
});

test("json() still rejects bad JSON with a SyntaxError and a used body with a TypeError", async () => {
  const { ctx } = contentScript();
  const names = await vm.runInContext(`(async () => {
    const out = [];
    try { await new Response("{nope").json(); } catch (e) { out.push(e.name); }
    const r = new Response("{}"); await r.text();
    try { await r.json(); } catch (e) { out.push(e.name); }
    return out;
  })()`, ctx);
  assert.deepEqual([...names], ["SyntaxError", "TypeError"]);
});

test("extension pages, and bundles that never call json(), keep Firefox's json()", () => {
  const none = contentScript("console.log(1);");
  assert.equal(vm.runInContext("Object.getOwnPropertyNames(Response.prototype).includes('json')", none.ctx), false);

  const page = pageRealm();
  const native = page.Response.prototype.json;
  runInContext(buildShim({}, { "p.js": CODE }), { browser: fakeBrowser(), globals: { Response: page.Response, Request: page.Request } });
  assert.equal(page.Response.prototype.json, native, "an extension page's json() is Firefox's");
});
