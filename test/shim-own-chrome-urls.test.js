import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildShim, fakeBrowser, runInContext, EXT_ORIGIN } from "./shim-sandbox.js";

// In Chrome an extension can request its own files at
// chrome-extension://<its id>/…, and fetch(getURL("manifest.json")) returns
// the manifest it shipped with. In Firefox the first fails with "NetworkError
// when attempting to fetch resource" (the add-on lives at
// moz-extension://<uuid>/), and the second returns the manifest lavaduct
// rewrote. McAfee WebAdvisor's WASM builds
// chrome-extension://<its id>/manifest.json at runtime and checks its
// content; failing that, the background never set up its message
// dispatcher, and nothing worked.

const ID = "fheoggkfdfchfphceeifdbepaooicaho";
const CHROME_MANIFEST = "lavaduct-chrome-manifest.json";

function context({ code = `const id = "${ID}";`, files = {}, href } = {}) {
  const requests = [];
  const fetch = (input, init) => {
    requests.push(typeof input === "string" ? input : input.url ?? String(input));
    return Promise.resolve({ ok: true, init });
  };
  class XMLHttpRequest {
    open(method, url) { requests.push(String(url)); }
  }
  const ctx = runInContext(buildShim({ extensionId: ID }, { "bg.js": code, ...files }), {
    browser: fakeBrowser(), href, globals: { fetch, XMLHttpRequest },
  });
  return { ctx, requests };
}

test("a request to the add-on's own Chrome origin goes to its Firefox origin", async () => {
  const { ctx, requests } = context();
  await vm.runInContext(`fetch("chrome-extension://${ID}/data/a.json?x=1#h")`, ctx);
  await vm.runInContext(`fetch(new URL("chrome-extension://${ID.toUpperCase()}/b.txt"))`, ctx);
  vm.runInContext(`new XMLHttpRequest().open("GET", "chrome-extension://${ID}/c.txt")`, ctx);
  assert.deepEqual(requests, [`${EXT_ORIGIN}/data/a.json?x=1#h`, `${EXT_ORIGIN}/b.txt`, `${EXT_ORIGIN}/c.txt`]);
});

test("other URLs, and an own-origin URL passed as a value, are requested as written", async () => {
  const { ctx, requests } = context();
  const other = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.js";
  const value = `https://auth.example.com/authorize?redirect_uri=chrome-extension://${ID}/cb.html`;
  await vm.runInContext(`fetch(${JSON.stringify(other)}); fetch(${JSON.stringify(value)}); fetch("${EXT_ORIGIN}/d.json")`, ctx);
  assert.deepEqual(requests, [other, value, `${EXT_ORIGIN}/d.json`]);
});

test("the add-on's own manifest.json is read as it shipped, from either origin", async () => {
  const { ctx, requests } = context({ code: `const id = "${ID}"; fetch(chrome.runtime.getURL("manifest.json"));`, files: { [CHROME_MANIFEST]: "{}" } });
  await vm.runInContext(`fetch("chrome-extension://${ID}/manifest.json"); fetch("/manifest.json"); fetch("${EXT_ORIGIN}/sub/manifest.json")`, ctx);
  assert.deepEqual(requests, [`${EXT_ORIGIN}/${CHROME_MANIFEST}`, `${EXT_ORIGIN}/${CHROME_MANIFEST}`, `${EXT_ORIGIN}/sub/manifest.json`]);
});

test("bundles that never name the Chrome ID or their manifest keep Firefox's fetch", async () => {
  const { ctx, requests } = context({ code: "console.log(1);" });
  await vm.runInContext(`fetch("chrome-extension://${ID}/a.json"); fetch("/manifest.json")`, ctx);
  assert.deepEqual(requests, [`chrome-extension://${ID}/a.json`, "/manifest.json"]);
});
