import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { buildShim, fakeBrowser, makeEvent, makeLocalStorage, runInContext, plain, tick, EXT_ORIGIN } from "./shim-sandbox.js";

// Chrome VPNs and proxy switchers call
//   chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: {...} }, scope: "regular" })
// (or mode "pac_script" with pacScript.data, as Browsec and Windscribe do).
// Firefox's proxy.settings takes another shape and, in Firefox 160, refuses any
// change unless the add-on may run in private windows: "proxy.settings requires
// private browsing permission." Urban VPN's Chrome build failed to connect on
// that. proxy.onRequest needs no such grant, and the shim routes with it.

const BUNDLE = { "bg.js": "chrome.proxy.settings.set({ value: { mode: 'direct' } });" };

function firefoxProxy() {
  const onRequest = makeEvent();
  const calls = [];
  const settings = {
    get: () => Promise.resolve({ value: { proxyType: "system", http: "", ssl: "", passthrough: "" }, levelOfControl: "controllable_by_this_extension" }),
    set: (d) => { calls.push(["set", d]); return Promise.reject(new Error("proxy.settings requires private browsing permission.")); },
    clear: (d) => { calls.push(["clear", d]); return Promise.resolve(true); },
    onChange: makeEvent(),
  };
  return { onRequest, settings, onError: makeEvent(), calls };
}

function load({ localStorage = makeLocalStorage(), href, files = BUNDLE, proxy = firefoxProxy() } = {}) {
  const browser = fakeBrowser({ extra: { proxy } });
  const ctx = runInContext(buildShim({}, files), { browser, href, globals: { localStorage, addEventListener() {} } });
  // Firefox calls every onRequest listener; the last answer that names a proxy wins.
  const route = async (url, extra = {}) => {
    let out;
    for (const fn of proxy.onRequest.listeners ?? []) {
      const r = await fn({ url, ...extra });
      if (r !== undefined) out = r;
    }
    return plain(out);
  };
  return { ctx, browser, proxy, localStorage, route };
}

test("fixed_servers sends requests to the proxy, per scheme, and bypassList and loopback go direct", async () => {
  const { ctx, route, proxy } = load();
  await vm.runInContext(`chrome.proxy.settings.set({ scope: "regular", value: { mode: "fixed_servers", rules: {
    proxyForHttp: { host: "10.0.0.1", port: 3128 },
    proxyForHttps: { scheme: "socks5", host: "10.0.0.2" },
    fallbackProxy: { scheme: "https", host: "fb.test", port: 8443 },
    bypassList: ["<local>", "*.corp.test", "skip.test:8080", "192.168.0.0/16", "http://plain.test", "[2001:db8::]/32"],
  } } })`, ctx);
  assert.deepEqual(proxy.calls, [], "Firefox's own proxy.settings isn't touched");
  assert.deepEqual(await route("http://example.com/"), { type: "http", host: "10.0.0.1", port: 3128 });
  assert.deepEqual(await route("https://example.com/"), { type: "socks", host: "10.0.0.2", port: 1080, proxyDNS: true });
  assert.deepEqual(await route("ftp://example.com/"), { type: "https", host: "fb.test", port: 8443 });
  for (const direct of ["http://intranet/", "https://a.corp.test/", "http://skip.test:8080/", "http://192.168.4.5/", "http://plain.test/", "http://localhost:3000/", "http://127.0.0.7/", "http://[::1]/", "http://[2001:db8::5]/"]) {
    assert.deepEqual(await route(direct), { type: "direct" }, direct);
  }
  assert.deepEqual(await route("http://skip.test/"), { type: "http", host: "10.0.0.1", port: 3128 }, "the port in a rule must match");
  assert.deepEqual(await route("https://plain.test/"), { type: "socks", host: "10.0.0.2", port: 1080, proxyDNS: true }, "the scheme in a rule must match");

  await vm.runInContext(`chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: { singleProxy: { host: "p.test", port: 1 }, bypassList: ["<-loopback>"] } } })`, ctx);
  assert.deepEqual(await route("http://127.0.0.1/"), { type: "http", host: "p.test", port: 1 }, "<-loopback> removes the implicit bypass");
});

test("get answers what was set with Chrome's levelOfControl, clear goes back to Firefox's, onChange fires", async () => {
  const { ctx, route } = load();
  ctx.changes = [];
  vm.runInContext("chrome.proxy.settings.onChange.addListener((d) => changes.push(d))", ctx);
  const before = plain(await vm.runInContext("chrome.proxy.settings.get({ incognito: false })", ctx));
  assert.equal(before.value.mode, "system");
  assert.equal(before.levelOfControl, "controllable_by_this_extension");
  const value = { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "p.test", port: 8080 }, bypassList: ["a.test"] } };
  await vm.runInContext(`chrome.proxy.settings.set({ value: ${JSON.stringify(value)}, scope: "regular" })`, ctx);
  assert.deepEqual(plain(await vm.runInContext("chrome.proxy.settings.get({})", ctx)), { value, levelOfControl: "controlled_by_this_extension" });
  const viaCallback = await new Promise((resolve) => { ctx.done = resolve; vm.runInContext("chrome.proxy.settings.get({}, done)", ctx); });
  assert.equal(plain(viaCallback).value.rules.singleProxy.host, "p.test");
  await tick(5);
  assert.equal(plain(ctx.changes.at(-1)).value.mode, "fixed_servers");

  await vm.runInContext("chrome.proxy.settings.clear({ scope: 'regular' })", ctx);
  assert.equal(await route("http://example.com/"), undefined, "nothing routed after clear");
  assert.equal(plain(await vm.runInContext("chrome.proxy.settings.get({})", ctx)).value.mode, "system");
  await tick(5);
  assert.equal(plain(ctx.changes.at(-1)).value.mode, "system");
});

test("a bad config is refused the way Chrome refuses it, through lastError for a callback", async () => {
  const { ctx } = load();
  await assert.rejects(vm.runInContext("chrome.proxy.settings.set({ value: { mode: 'warp' } })", ctx), /mode/);
  await assert.rejects(vm.runInContext("chrome.proxy.settings.set({ value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'quic', host: 'q.test' } } } })", ctx), /QUIC/);
  const err = await new Promise((resolve) => {
    ctx.done = () => resolve(ctx.chrome.runtime.lastError && ctx.chrome.runtime.lastError.message);
    vm.runInContext("chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: {} } }, done)", ctx);
  });
  assert.match(err, /pacScript/);
});

test("the config survives the event page being suspended, and a page's change reaches the background", async () => {
  const storage = makeLocalStorage();
  const page = load({ localStorage: storage, href: EXT_ORIGIN + "/popup.html" });
  await vm.runInContext("chrome.proxy.settings.set({ value: { mode: 'fixed_servers', rules: { singleProxy: { host: 'p.test', port: 9 } } } })", page.ctx);
  // The background wakes later and reads the config before any request waits on it.
  const bg = load({ localStorage: storage });
  assert.deepEqual(await bg.route("http://example.com/"), { type: "http", host: "p.test", port: 9 });
  assert.equal(page.proxy.onRequest.listeners?.length ?? 0, 0, "only the background routes");
});

test("auto_detect and Firefox-shaped values go to Firefox's proxy.settings, whose refusal is reported", async () => {
  const { ctx, proxy } = load();
  await assert.rejects(vm.runInContext("chrome.proxy.settings.set({ value: { mode: 'auto_detect' } })", ctx), /private windows/);
  await assert.rejects(vm.runInContext("chrome.proxy.settings.set({ value: { proxyType: 'none' } })", ctx), /private browsing permission/);
  assert.deepEqual(plain(proxy.calls.map((c) => c[1].value)), [{ proxyType: "autoDetect" }, { proxyType: "none" }]);
});

test("the add-on's own proxy.onRequest listeners are left alone", async () => {
  const { ctx, proxy } = load({ files: { "bg.js": "chrome.proxy.settings.get({}); chrome.proxy.onRequest.addListener(() => ({ type: 'direct' }), { urls: ['<all_urls>'] });" } });
  vm.runInContext("chrome.proxy.onRequest.addListener(function own() { return { type: 'direct' }; }, { urls: ['<all_urls>'] })", ctx);
  await vm.runInContext("chrome.proxy.settings.set({ value: { mode: 'fixed_servers', rules: { singleProxy: { host: 'p.test', port: 9 } } } })", ctx);
  assert.equal(proxy.onRequest.listeners.length, 2);
});

test("a bundle that never names proxy.settings keeps Firefox's", () => {
  const proxy = firefoxProxy();
  const { browser } = load({ files: { "bg.js": "chrome.proxy.onRequest.addListener(() => {});" }, proxy });
  assert.equal(browser.proxy.settings, proxy.settings);
});

// The PAC side: pac-sandbox.js runs in the sandbox page the background frames.
const PAC_SOURCE = readFileSync(new URL("../dist/runtime/pac-sandbox.js", import.meta.url), "utf-8");

function pacContext() {
  const ctx = vm.createContext({});
  vm.runInContext(PAC_SOURCE, ctx);
  return ctx;
}

test("a PAC script's answer, its helpers, and DNS asked for between rounds", () => {
  const ctx = pacContext();
  const script = `function FindProxyForURL(url, host) {
    if (isPlainHostName(host) || dnsDomainIs(host, ".local.test") || shExpMatch(url, "*://direct.test/*")) return "DIRECT";
    if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "PROXY ten.test:1";
    if (isInNetEx(host, "2001:db8::/32")) return "SOCKS5 six.test:2";
    if (isResolvable(host) && isInNet(dnsResolve(host), "192.0.2.0", "255.255.255.0")) return "HTTPS doc.test:3";
    return "PROXY p.test:8080; DIRECT";
  }`;
  const run = (url, host, dns) => plain(ctx.evaluatePac(script, url, host, dns));
  assert.deepEqual(run("http://intranet/", "intranet"), { result: "DIRECT" });
  assert.deepEqual(run("http://a.local.test/", "a.local.test"), { result: "DIRECT" });
  assert.deepEqual(run("http://direct.test/x", "direct.test"), { result: "DIRECT" });
  assert.deepEqual(run("http://10.1.2.3/", "10.1.2.3"), { result: "PROXY ten.test:1" });
  assert.deepEqual(run("http://[2001:db8::1]/", "2001:db8::1"), { result: "SOCKS5 six.test:2" });
  assert.deepEqual(run("http://name.test/", "name.test"), { needDns: "name.test" });
  assert.deepEqual(run("http://name.test/", "name.test", { "name.test": ["192.0.2.9"] }), { result: "HTTPS doc.test:3" });
  assert.deepEqual(run("http://name.test/", "name.test", { "name.test": [] }), { result: "PROXY p.test:8080; DIRECT" });
  assert.throws(() => ctx.evaluatePac("var x = 1;", "http://a/", "a"), /FindProxyForURL/);
});

test("pac_script routes through the sandbox's answer, and a failing script goes direct unless mandatory", async () => {
  const { ctx, route } = load();
  // Stand in for the sandbox frame: answer as pac-sandbox.js would.
  const pac = pacContext();
  ctx.document = {
    body: { appendChild(f) { setTimeout(() => f.onloadCb && f.onloadCb(), 0); } },
    createElement() {
      const f = {
        style: {},
        addEventListener(type, cb) { if (type === "load") f.onloadCb = cb; },
        contentWindow: {
          postMessage(m) {
            let reply;
            try { reply = pac.evaluatePac(m.script, m.url, m.host, m.dns); } catch (e) { reply = { error: e.message }; }
            Object.assign(reply, { __lavaductPac: true, id: m.id });
            setTimeout(() => ctx.__onMessage({ source: f.contentWindow, data: reply }), 0);
          },
        },
      };
      return f;
    },
  };
  ctx.addEventListener = (type, cb) => { if (type === "message") ctx.__onMessage = cb; };
  const data = "function FindProxyForURL(url, host) { return host === 'go.test' ? 'DIRECT' : 'PROXY p.test:3128; SOCKS s.test:1080'; }";
  await vm.runInContext(`chrome.proxy.settings.set({ value: { mode: "pac_script", pacScript: { data: ${JSON.stringify(data)} } } })`, ctx);
  assert.deepEqual(await route("http://go.test/"), [{ type: "direct" }]);
  assert.deepEqual(await route("https://example.com/secret?q=1"), [{ type: "http", host: "p.test", port: 3128 }, { type: "socks4", host: "s.test", port: 1080 }]);

  await vm.runInContext(`chrome.proxy.settings.set({ value: { mode: "pac_script", pacScript: { data: "function FindProxyForURL() { throw new Error('x'); }" } } })`, ctx);
  assert.deepEqual(await route("http://example.com/"), { type: "direct" });
  await vm.runInContext(`chrome.proxy.settings.set({ value: { mode: "pac_script", pacScript: { data: "function FindProxyForURL() { throw new Error('x'); }", mandatory: true } } })`, ctx);
  assert.deepEqual(await route("http://example.com/"), [{ type: "http", host: "pac-script-failed.invalid", port: 1 }]);
});
