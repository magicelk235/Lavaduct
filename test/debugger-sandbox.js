// Helpers for the chrome.debugger emulation tests: a node:vm context stands in
// for each frame of a tab, and extension contexts of one add-on share runtime
// messaging and BroadcastChannel. Not a test file itself.
import vm from "node:vm";
import { buildShim, fakeBrowser, makeEvent, runInContext, plain, EXT_ORIGIN } from "./shim-sandbox.js";

export const SHIM = buildShim({ debuggerEmulation: true });

// The page's own Promise.prototype, kept before any page script can replace
// window.Promise: Firefox awaits a script's result only when it is a native
// promise of the page.
const nativePromiseProto = new WeakMap();

/** A page context whose syntax errors read like Firefox's. `script` runs as the page's own code. */
export function makePage({ title = "Test page", devicePixelRatio = 1, href = "https://example.test/", script = "" } = {}) {
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const page = vm.createContext({ console: quiet, setTimeout, clearTimeout, JSON, devicePixelRatio, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0 });
  nativePromiseProto.set(page, vm.runInContext("Promise.prototype", page));
  vm.runInContext(`
    var window = globalThis;
    var document = { title: ${JSON.stringify(title)}, documentElement: { scrollWidth: 800, scrollHeight: 2000, clientWidth: 800, clientHeight: 600 }, body: {} };
    var location = { href: ${JSON.stringify(href)} };
    var CustomEvent = function (type, init) { this.type = type; this.detail = init && init.detail; };
    var __listeners = {};
    window.addEventListener = function (type, fn) { (__listeners[type] = __listeners[type] || []).push(fn); };
    window.removeEventListener = function () {};
    window.dispatchEvent = function (ev) { (__listeners[ev.type] || []).forEach(function (fn) { fn(ev); }); return true; };
    window.alert = function alert() { return "native alert"; };
    window.confirm = function confirm() { return "native confirm"; };
    window.prompt = function prompt() { return "native prompt"; };
    var __eval = eval;
    eval = function (code) {
      try { return __eval(code); } catch (e) {
        if (e && e.name === "SyntaxError" && e.message === "Illegal return statement") e.message = "return not in function";
        throw e;
      }
    };
  `, page);
  if (script) vm.runInContext(script, page);
  return page;
}

/**
 * scripting.executeScript the way Firefox runs it: the function's source in
 * each target frame, a native promise awaited (anything else, a page's own
 * thenable included, is returned as it is), and the result structured-cloned,
 * which fails the whole call when it can't be.
 */
async function runInFrame(page, details) {
  const fn = vm.runInContext("(" + details.func.toString() + ")", page);
  const args = vm.runInContext("JSON.parse", page)(JSON.stringify(details.args || []));
  let value;
  try {
    value = fn(...args);
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === nativePromiseProto.get(page)) value = await value;
  } catch (e) {
    return { error: e };
  }
  try {
    return { result: structuredClone(value ?? null) };
  } catch {
    throw new Error("Script '<anonymous code>' result is non-structured-clonable data");
  }
}

/** Runtime messaging and BroadcastChannel between the contexts of one add-on. */
export function makeBus() {
  const channels = [];
  const bus = {
    contexts: [],
    send(from, message) {
      // Every listener of every other context hears it; the first promise answers.
      let answer;
      for (const to of bus.contexts) {
        if (to === from) continue;
        for (const fn of to.runtime.onMessage.listeners.slice()) {
          const r = fn(JSON.parse(JSON.stringify(message)), { id: from.runtime.id, url: EXT_ORIGIN + "/page.html" }, () => {});
          if (!answer && r && typeof r.then === "function") answer = r;
        }
      }
      return answer ?? Promise.resolve(undefined);
    },
    Channel: class {
      constructor(name) {
        this.name = name;
        this.onmessage = null;
        channels.push(this);
      }
      postMessage(data) {
        for (const c of channels) {
          if (c !== this && c.name === this.name) setTimeout(() => c.onmessage && c.onmessage({ data: structuredClone(data) }), 0);
        }
      }
    },
  };
  return bus;
}

/**
 * One extension context of the add-on: its browser namespace, wired to `bus`.
 * `frames` maps Firefox frame IDs to page contexts; `page` is frame 0.
 */
export function extensionContext(bus, { href, tabs, page, frames, zoom = 1, captures = [], session }) {
  const allFrames = frames || { 0: page };
  const browser = fakeBrowser();
  if (session) browser.storage.session = session;
  browser.runtime.sendMessage = (message) => bus.send(browser, message);
  browser.tabs = {
    get: (id) => (tabs[id] ? Promise.resolve({ id, windowId: 1, index: 0, ...tabs[id] }) : Promise.reject(new Error(`Invalid tab ID: ${id}`))),
    query: () => Promise.resolve(Object.keys(tabs).map((id) => ({ id: Number(id), windowId: 1, ...tabs[id] }))),
    create: (props) => Promise.resolve({ id: 99, ...props }),
    update: (id, props) => Promise.resolve({ id, ...props }),
    reload: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    getZoom: () => Promise.resolve(zoom),
    captureTab: (tabId, opts) => {
      captures.push({ tabId, opts: plain(opts) });
      return Promise.resolve("data:image/" + (opts.format === "jpeg" ? "jpeg" : "png") + ";base64,QUJD");
    },
    onRemoved: makeEvent(),
    onUpdated: makeEvent(),
  };
  browser.scripting = {
    executeScript: async (details) => {
      const ids = details.target.allFrames ? Object.keys(allFrames).map(Number) : details.target.frameIds || [0];
      const out = [];
      for (const frameId of ids) {
        if (!allFrames[frameId]) throw new Error(`Invalid frame IDs: [${frameId}].`);
        out.push({ frameId, ...(await runInFrame(allFrames[frameId], details)) });
      }
      return out;
    },
  };
  const navEvents = ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted", "onErrorOccurred", "onHistoryStateUpdated", "onReferenceFragmentUpdated"];
  browser.webNavigation = Object.fromEntries(navEvents.map((n) => [n, makeEvent()]));
  browser.webNavigation.getAllFrames = () => Promise.resolve([{ frameId: 0, parentFrameId: -1, url: "https://example.test/" }]);
  const wrEvents = ["onBeforeRequest", "onSendHeaders", "onBeforeRedirect", "onResponseStarted", "onCompleted", "onErrorOccurred"];
  browser.webRequest = Object.fromEntries(wrEvents.map((n) => [n, makeEvent()]));
  // The emulation keeps an event page awake with an interval while a tab is
  // attached; it mustn't keep the test process alive.
  const unrefInterval = (fn, ms) => setInterval(fn, ms).unref();
  runInContext(SHIM, { browser, href, globals: { BroadcastChannel: bus.Channel, setInterval: unrefInterval } });
  bus.contexts.push(browser);
  return { browser };
}

/**
 * A background page with one attached-to-be tab. The tab's frames get the
 * `browser.runtime.sendMessage` a content script has, which reaches the
 * background's listeners as from that tab and frame.
 */
export function setup({ page = makePage(), frames, zoom = 1, tabs = { 1: { url: "https://example.test/", title: "Test page" } } } = {}) {
  const bus = makeBus();
  const captures = [];
  const bg = extensionContext(bus, { href: EXT_ORIGIN + "/_generated_background_page.html", tabs, page, frames, zoom, captures });
  const tabId = Number(Object.keys(tabs)[0]);
  for (const [frameId, context] of Object.entries(frames || { 0: page })) {
    context.browser = {
      runtime: {
        getFrameId: () => -1,
        sendMessage(message) {
          const sender = { id: bg.browser.runtime.id, tab: { id: tabId }, frameId: Number(frameId), url: "https://example.test/" };
          for (const fn of bg.browser.runtime.onMessage.listeners.slice()) fn(JSON.parse(JSON.stringify(message)), sender, () => {});
          return Promise.resolve();
        },
      },
    };
  }
  return { bus, bg, page, captures, tabs };
}

export const send = (browser, tabId, method, params = {}) => browser.debugger.sendCommand({ tabId }, method, params);
