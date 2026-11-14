import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShim, fakeBrowser, runInContext } from "./shim-sandbox.js";

// Chrome's management API gives an extension installed from the Web Store,
// without a homepage_url of its own, the store's detail page as homepageUrl
// (ManifestURL::GetHomepageURL). Firefox leaves homepageUrl out when the
// manifest has none, and BlockSite's install analytics read
// getSelf().homepageUrl.length and threw. The shim fills it in for the add-on
// itself, only when the Chrome ID is known and the add-on came from the store.

const STORE = "https://chromewebstore.google.com/detail/eiimnmioipafcokbfikbljfdeojpcgbh";
const FILES = { "bg.js": "chrome.management.getSelf().then((i) => i.homepageUrl.length);" };

function setup(config, infos) {
  const browser = fakeBrowser();
  browser.management = {
    getSelf: (cb) => { const p = Promise.resolve({ ...infos.self }); if (cb) { p.then(cb); return undefined; } return p; },
    get: (id) => Promise.resolve({ ...(infos[id] ?? { id }) }),
  };
  runInContext(buildShim(config, FILES), { browser });
  return browser;
}

test("getSelf() and get(own id) give a store add-on the Web Store page, as Chrome does", async () => {
  const self = { id: "addon@example.test", name: "T" };
  const browser = setup({ extensionId: "eiimnmioipafcokbfikbljfdeojpcgbh", webStoreHomepage: STORE }, { self, "addon@example.test": self, other: { id: "other" } });
  assert.equal((await browser.management.getSelf()).homepageUrl, STORE);
  assert.equal((await browser.management.get("addon@example.test")).homepageUrl, STORE);
  assert.equal((await browser.management.get("other")).homepageUrl, undefined, "another add-on's info is left alone");
  const viaCallback = await new Promise((r) => browser.management.getSelf(r));
  assert.equal(viaCallback.homepageUrl, STORE);
});

test("a homepage Firefox already reports is kept", async () => {
  const self = { id: "addon@example.test", homepageUrl: "https://vendor.example/" };
  const browser = setup({ extensionId: "eiimnmioipafcokbfikbljfdeojpcgbh", webStoreHomepage: STORE }, { self });
  assert.equal((await browser.management.getSelf()).homepageUrl, "https://vendor.example/");
});

test("an add-on not from the store gets nothing, as in Chrome", async () => {
  const browser = setup({ extensionId: "eiimnmioipafcokbfikbljfdeojpcgbh" }, { self: { id: "addon@example.test" } });
  assert.equal((await browser.management.getSelf()).homepageUrl, undefined);
});
