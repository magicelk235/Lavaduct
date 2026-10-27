// Helpers for running the generated compat shim inside node:vm against a fake
// Firefox WebExtension API. Not a test file itself.
import vm from "node:vm";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { writeShim } from "../dist/runtime/shim.js";

export const EXT_ORIGIN = "moz-extension://5f2a6c1e-0d7b-4c39-9a31-3c3f0e6a7b11";

/** Generate the shim for `config`, optionally next to some staged files. */
export function buildShim(config = {}, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shim-build-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    const file = writeShim(dir, config);
    return readFileSync(join(dir, file), "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A WebExtension-style event whose listeners the test can fire. */
export function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.includes(fn); },
    fire(...args) { return listeners.map((fn) => fn(...args)); },
  };
}

/** In-memory storage area shaped like browser.storage.local (promise API). */
export function makeStorageArea(data = {}) {
  return {
    data,
    get(keys) {
      const out = {};
      const list = keys == null ? Object.keys(data) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return Promise.resolve(out);
    },
    set(items) { for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v); return Promise.resolve(); },
    remove(keys) { for (const k of [].concat(keys)) delete data[k]; return Promise.resolve(); },
  };
}

/** Minimal synchronous localStorage. Pass the same instance to simulate a restart. */
export function makeLocalStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/**
 * A fake `browser` namespace. `lastError` is a configurable getter like
 * Firefox's, reading `nativeLastError`.
 */
export function fakeBrowser({ manifest = { manifest_version: 3, name: "T", version: "1" }, extra = {} } = {}) {
  const calls = [];
  const runtime = {
    id: "addon@example.test",
    getURL: (p) => EXT_ORIGIN + "/" + String(p).replace(/^\/+/, ""),
    getManifest: () => manifest,
    onMessage: makeEvent(),
    onMessageExternal: makeEvent(),
    onConnect: makeEvent(),
    sendMessage: (...args) => { calls.push(["runtime.sendMessage", ...args]); return Promise.resolve(); },
    getPlatformInfo: () => { calls.push(["runtime.getPlatformInfo"]); return Promise.resolve({ os: "mac" }); },
    nativeLastError: null,
  };
  Object.defineProperty(runtime, "lastError", {
    configurable: true,
    enumerable: true,
    get() { return runtime.nativeLastError; },
  });
  const browser = {
    calls,
    runtime,
    storage: { local: makeStorageArea(), session: makeStorageArea(), onChanged: makeEvent() },
    tabs: { query: () => Promise.resolve([]) },
    windows: {
      create: (opts) => { calls.push(["windows.create", opts]); return Promise.resolve({ id: 9 }); },
    },
    extension: { getViews: () => [] },
    ...extra,
  };
  return browser;
}

export function fakeSidebarAction(calls) {
  let panel = "";
  return {
    open: () => { calls.push(["sidebarAction.open"]); return Promise.resolve(); },
    close: () => { calls.push(["sidebarAction.close"]); return Promise.resolve(); },
    toggle: () => { calls.push(["sidebarAction.toggle"]); return Promise.resolve(); },
    setPanel: (d) => { calls.push(["sidebarAction.setPanel", d]); if (d.tabId == null) panel = d.panel; return Promise.resolve(); },
    getPanel: (d) => { calls.push(["sidebarAction.getPanel", d]); return Promise.resolve(panel); },
    setDefault(p) { panel = p; },
  };
}

/**
 * Run `source` in a fresh context that looks like a Firefox extension context.
 * `href` decides what kind: the generated background page, another extension
 * page, or (for an http(s) URL) a content script.
 */
export function runInContext(source, { browser, chrome, href = EXT_ORIGIN + "/_generated_background_page.html", globals = {} } = {}) {
  const url = new URL(href);
  const location = {
    href: url.href, protocol: url.protocol, origin: url.origin, host: url.host,
    hostname: url.hostname, pathname: url.pathname, search: url.search, hash: url.hash,
  };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone,
    Response, Headers, Blob,
    location,
    ...(browser ? { browser } : {}),
    ...((chrome || browser) ? { chrome: chrome || browser } : {}),
    ...globals,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  if (!("top" in globals)) sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "compat-shim.js" });
  return sandbox;
}

/** Copy a value out of the vm realm so deepStrictEqual compares plain data. */
export const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
