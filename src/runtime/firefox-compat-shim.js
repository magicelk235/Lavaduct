// Firefox compatibility shim for converted Chrome extensions.
//
// Loaded first in the background scripts, in every content script and in every
// extension page. Firefox implements most of chrome.* itself, so this only fills
// the gaps:
//   - chrome.sidePanel, on top of the manifest's sidebar_action;
//   - chrome.offscreen, as a hidden iframe in the event page (background only);
//   - identity.getAuthToken and friends, on top of launchWebAuthFlow;
//   - chrome://favicon/ and /_favicon/ URLs, for fetch() and <img>;
//   - chrome.debugger, spliced in for add-ons that use it (cdp-emulation.js);
//   - ServiceWorkerGlobalScope in a background that was a service worker;
//   - the service worker's messaging: navigator.serviceWorker in the
//     extension's pages, and `clients`, `registration` and the `message` event
//     in the background, over window.postMessage;
//   - chrome://newtab URLs, which tabs.create and windows.create refuse;
//   - the add-on's Chrome origin on its own requests;
//   - Chrome's enum objects that Firefox's declarativeNetRequest, identity and
//     storage lack;
//   - declarativeNetRequest rules added at runtime that Firefox would refuse;
//   - OFFSCREEN_DOCUMENT in runtime.getContexts, for the offscreen emulation;
//   - storage.session.setAccessLevel, which code waits on, and the session
//     area where Firefox has none (content scripts, pages framed in a site);
//   - window.chrome in content scripts, and json() bodies in their own realm;
//   - CustomEvent details a content script hands the page, which Chrome clones
//     for the page's world;
//   - selectors holding runtime.id unquoted, which a Chrome ID parses in and
//     Firefox's gecko ID doesn't;
//   - storage.managed.get() without a policy, which Chrome answers as an empty area;
//   - runtime.onUserScriptMessage/onUserScriptConnect before Firefox's runtime
//     userScripts grant, Chrome's chrome.runtime in the USER_SCRIPT world, and
//     relative import() in registered user-script code, against the add-on;
//   - webpack chunks of a worker bundle, listed ahead of the worker;
//   - runtime.onInstalled's repeated "install" for an add-on that is loaded
//     temporarily again and again;
//   - the "browser_action" menu context, which Firefox refuses from MV3;
//   - Chrome's callback on methods Firefox only gives a promise;
//   - messages and ports addressed to the add-on's own Chrome ID.
// A member is only defined where Firefox has none, and the parts with side
// effects are only emitted for an add-on whose code needs them. Firefox's own
// methods are wrapped only to translate an argument Chrome accepts and Firefox
// refuses, an answer Chrome gives and Firefox doesn't, or to keep the shim's
// internal messages from the add-on's listeners.
//
// The shim shares its script evaluation with the extension's own background
// code, so nothing may throw out of it.
(function () {
  "use strict";

  var CONFIG = {};
  try { CONFIG = __SHIM_CONFIG_JSON__ || {}; } catch (e) {}

  // Content scripts evaluate the shim once per matching content_scripts entry,
  // all in the same sandbox, so install once.
  var G = typeof globalThis !== "undefined" ? globalThis : self;
  try {
    if (G.__firefoxCompatShim) return;
    Object.defineProperty(G, "__firefoxCompatShim", { value: true, configurable: true });
  } catch (e) { return; }

  var __SHIM_DEBUG__ = false;
  // __SHIM_DEBUG_RING__
  function dbg() {
    if (!__SHIM_DEBUG__) return;
    var args = ["[compat-shim]"].concat(Array.prototype.slice.call(arguments));
    try { console.log.apply(console, args); } catch (e) {}
    try { if (typeof __SHIM_DEBUG_WRITE__ === "function") __SHIM_DEBUG_WRITE__(args); } catch (e) {}
  }

  // In MV2 extension pages `chrome` and `browser` are separate objects; anywhere
  // else they are the same one.
  var namespaces = [];
  try { if (typeof browser === "object" && browser) namespaces.push(browser); } catch (e) {}
  try { if (typeof chrome === "object" && chrome && namespaces.indexOf(chrome) < 0) namespaces.push(chrome); } catch (e) {}
  if (!namespaces.length) {
    // A manifest sandbox page: no extension API in either browser, but Chrome
    // defines window.chrome on every page, an object without extension
    // namespaces, and code written for Chrome reads it unguarded
    // (webextension-polyfill's wrapAPIs). Firefox defines none.
    try {
      if (typeof chrome === "undefined" && location.protocol === "moz-extension:") {
        Object.defineProperty(G, "chrome", { value: {}, writable: true, configurable: true, enumerable: true });
      }
    } catch (e) {}
    return;
  }
  // Our own calls go through the promise-returning namespace.
  var api = namespaces[0];

  var nativeFetch = null;
  try { if (typeof fetch === "function") nativeFetch = fetch; } catch (e) {}

  var loc = null;
  try { loc = location; } catch (e) {}
  var isExtensionPage = !!loc && loc.protocol === "moz-extension:";
  var hasDocument = false;
  try { hasDocument = typeof document !== "undefined" && !!document; } catch (e) {}
  var isTopFrame = true;
  try { isTopFrame = typeof window === "undefined" || window.top === window; } catch (e) { isTopFrame = false; }
  var isBackground = isExtensionPage && isTopFrame && detectBackground();
  // A converted worker's chunks are loaded by its pages too, so their "am I the
  // worker?" checks were rewritten to `check || globalThis.__lavaductBackground
  // === true` (src/input/stage.ts rewriteHoistedBackgroundChecks): true here only.
  if (isBackground) {
    try { Object.defineProperty(G, "__lavaductBackground", { value: true, configurable: true }); } catch (e) {}
  }

  var ORIGIN = "";
  try { ORIGIN = String(api.runtime.getURL("/")).replace(/\/+$/, ""); } catch (e) {}

  var localStore = null;
  try { localStore = typeof localStorage !== "undefined" ? localStorage : null; } catch (e) {}

  function detectBackground() {
    var path = loc.pathname;
    // background.scripts run in a page Firefox generates under this name.
    if (path === "/_generated_background_page.html") return true;
    try {
      var bg = api.runtime.getManifest().background;
      if (bg && typeof bg.page === "string" && path === "/" + bg.page.replace(/^\/+/, "")) return true;
    } catch (e) {}
    try {
      return !!(api.extension && typeof api.extension.getBackgroundPage === "function" &&
        api.extension.getBackgroundPage() === window);
    } catch (e) {}
    return false;
  }

  function noop() {}

  function errorMessage(err) {
    return String((err && err.message) || err || "Unknown error");
  }

  // A thrown callback should surface like it would from a native callback, not
  // disappear into a promise chain.
  function invoke(fn, args) {
    try { fn.apply(null, args); } catch (e) { setTimeout(function () { throw e; }, 0); }
  }

  // Chrome's runtime.lastError, set only while the callback runs. Firefox's own
  // lastError is a getter with no setter, so it is shadowed for the duration of
  // the callback and the original descriptor goes straight back afterwards.
  function withLastError(ns, err, fn) {
    var rt = ns && ns.runtime;
    var saved;
    var shadowed = false;
    try {
      saved = Object.getOwnPropertyDescriptor(rt, "lastError");
      Object.defineProperty(rt, "lastError", {
        value: { message: errorMessage(err) }, configurable: true, enumerable: true, writable: true,
      });
      shadowed = true;
    } catch (e) {}
    try {
      fn();
    } finally {
      if (shadowed) {
        try {
          if (saved) Object.defineProperty(rt, "lastError", saved);
          else delete rt.lastError;
        } catch (e) {}
      }
    }
  }

  // Chrome's async calls take an optional trailing callback and return a promise
  // when there is none. `spread` passes an array result as separate arguments.
  function respond(ns, promise, cb, spread) {
    if (typeof cb !== "function") return promise;
    promise.then(function (value) {
      invoke(cb, spread ? value : [value]);
    }, function (err) {
      withLastError(ns, err, function () { invoke(cb, []); });
    });
    return undefined;
  }

  // Firefox declares some methods Chrome gives a callback as promise-only
  // (`"async": true` in its schemas) and refuses a trailing function with
  // "Incorrect argument types". obj[name] then takes the callback off, calls
  // Firefox's method, and answers the callback the way Chrome does. A call
  // without one goes through untouched, and a synchronous throw (Chrome's own
  // argument errors) still throws.
  var callbackWrapped = typeof WeakSet === "function" ? new WeakSet() : null;
  function acceptCallback(ns, obj, name) {
    var original;
    try { original = obj && obj[name]; } catch (e) { return; }
    if (typeof original !== "function" || !callbackWrapped || callbackWrapped.has(original)) return;
    var wrapper = function () {
      var args = Array.prototype.slice.call(arguments);
      if (!args.length || typeof args[args.length - 1] !== "function") return original.apply(obj, args);
      var cb = args.pop();
      return respond(ns, Promise.resolve(original.apply(obj, args)), cb);
    };
    callbackWrapped.add(wrapper);
    replaceMember(obj, name, wrapper);
  }

  // The promise-only methods Chrome calls back from, by namespace (Firefox
  // 160's schemas). browserAction takes action's. userScripts is wrapped with
  // the rest of that namespace, when Firefox grants it (wrapUserScripts).
  var PROMISE_ONLY = {
    action: ["getBadgeTextColor", "setBadgeTextColor", "isEnabled", "openPopup"],
    browserAction: ["getBadgeTextColor", "setBadgeTextColor", "isEnabled", "openPopup"],
    pageAction: ["setPopup"],
    tabs: ["discard", "ungroup"],
    userScripts: ["register", "update", "unregister", "configureWorld", "resetWorldConfiguration"],
  };

  // Only for the methods the bundle names (CONFIG.promiseOnlyCalls).
  function installPromiseOnlyCallbacks() {
    var names = CONFIG.promiseOnlyCalls;
    if (!Array.isArray(names) || !names.length) return;
    namespaces.forEach(function (ns) {
      Object.keys(PROMISE_ONLY).forEach(function (area) {
        if (area === "userScripts") return;
        var obj = null;
        try { obj = ns[area]; } catch (e) {}
        if (!obj || typeof obj !== "object") return;
        PROMISE_ONLY[area].forEach(function (name) {
          if (names.indexOf(name) >= 0) acceptCallback(ns, obj, name);
        });
      });
    });
  }

  function makeEvent() {
    var listeners = [];
    return {
      event: {
        addListener: function (fn) { if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn); },
        removeListener: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
        hasListener: function (fn) { return listeners.indexOf(fn) >= 0; },
        hasListeners: function () { return listeners.length > 0; },
      },
      dispatch: function () {
        var args = arguments;
        listeners.slice().forEach(function (fn) { invoke(fn, args); });
      },
    };
  }

  // Define obj[name] only when Firefox has nothing there.
  function defineMissing(obj, name, value) {
    if (!obj) return false;
    try { if (obj[name] != null) return false; } catch (e) { return false; }
    try {
      Object.defineProperty(obj, name, { value: value, writable: true, configurable: true, enumerable: true });
      return true;
    } catch (e) {}
    try { obj[name] = value; } catch (e) {}
    return obj[name] === value;
  }

  // Put the shim's wrapper in place of obj[name].
  function replaceMember(obj, name, value) {
    try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true, enumerable: true }); } catch (e) {}
  }

  function readLocal(key) {
    try {
      var v = localStore && localStore.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch (e) { return null; }
  }

  function writeLocal(key, value) {
    try { if (localStore) localStore.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function stripSlashes(p) {
    return String(p || "").replace(/^\/+/, "");
  }

  // URLs of the add-on's own files, built from strings rather than URL.origin:
  // moz-extension: isn't a special scheme, so URL objects aren't reliable about it.
  function extensionUrl(p) {
    var s = String(p || "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
    return ORIGIN + "/" + stripSlashes(s);
  }

  function relativePath(url) {
    var s = String(url || "");
    if (ORIGIN && s.indexOf(ORIGIN + "/") === 0) return s.slice(ORIGIN.length + 1);
    return s;
  }

  function originOf(u) {
    return u.protocol + "//" + u.host;
  }

  // ── Messages between the shim's own pages ──────────────────────────────────
  // Parts of the shim talk to the background page over runtime messages that
  // carry one of these keys. Every page of the add-on hears every runtime
  // message, so runtime.onMessage is wrapped to keep them from the add-on's own
  // listeners; the shim's listener for a key goes in underneath, where it hears
  // them.
  var internalKeys = [];
  var wrappedMessageEvents = [];

  function isInternalMessage(message) {
    if (!message || typeof message !== "object") return false;
    for (var i = 0; i < internalKeys.length; i++) {
      try { if (message[internalKeys[i]]) return true; } catch (e) {}
    }
    return false;
  }

  // Wrap one onMessage event's listener methods, once; returns its own addListener.
  function wrapMessageEvent(ev) {
    for (var i = 0; i < wrappedMessageEvents.length; i++) {
      if (wrappedMessageEvents[i].ev === ev) return wrappedMessageEvents[i].add;
    }
    var nativeAdd = ev.addListener;
    var nativeRemove = ev.removeListener;
    var nativeHas = ev.hasListener;
    wrappedMessageEvents.push({ ev: ev, add: nativeAdd });
    var wrappers = new Map();
    function wrap(fn) {
      var w = wrappers.get(fn);
      if (!w) {
        w = function (message) {
          if (isInternalMessage(message)) return undefined;
          return fn.apply(this, arguments);
        };
        wrappers.set(fn, w);
      }
      return w;
    }
    replaceMember(ev, "addListener", function (fn) {
      if (typeof fn !== "function") return nativeAdd.apply(ev, arguments);
      return nativeAdd.call(ev, wrap(fn));
    });
    replaceMember(ev, "removeListener", function (fn) {
      return nativeRemove.call(ev, wrappers.get(fn) || fn);
    });
    replaceMember(ev, "hasListener", function (fn) {
      return nativeHas.call(ev, wrappers.get(fn) || fn);
    });
    return nativeAdd;
  }

  // Keep messages carrying `key` from the add-on's listeners, and register
  // `internal` (if any) for them. In MV2 pages `chrome` and `browser` each
  // have an onMessage, and a listener on either hears every message, so
  // `internal` goes on one of them only.
  function hideInternalMessages(key, internal) {
    if (internalKeys.indexOf(key) < 0) internalKeys.push(key);
    var pending = internal;
    namespaces.forEach(function (ns) {
      var ev = null;
      try { ev = ns.runtime && ns.runtime.onMessage; } catch (e) {}
      if (!ev || typeof ev.addListener !== "function") return;
      var add = wrapMessageEvent(ev);
      if (pending) {
        add.call(ev, pending);
        pending = null;
      }
    });
  }

  // ── chrome.sidePanel ────────────────────────────────────────────────────────
  // The panel is Firefox's sidebar: the converter declares a sidebar_action for
  // the manifest's side_panel, or for the page the bundle passes to setOptions
  // when it declares none. Firefox's sidebar is per window, opens only from a
  // user action, and has no enable/disable switch, so `enabled` is tracked here.
  // Without a sidebar_action the panel opens as a popup window.
  //
  // An add-on whose Chrome manifest declares no side panel (CONFIG.noDefaultPanel)
  // has one only on the tabs its code gives one, with setOptions({ tabId, path }),
  // usually from its toolbar button; Chrome shows nothing on its other tabs.
  // Such a panel often finds its tab in its URL (sidepanel.html?tabId=42).
  // Firefox's sidebar stays open across tabs, though, and shows the
  // sidebar_action page on any tab without a panel of its own: after a switch
  // to another tab, and when the user opens the sidebar from Firefox's own UI.
  // That page has no tab, and Chrome never shows it. So the page a tab's panel
  // puts in the sidebar stays there for the window's other tabs, and a sidebar
  // that comes up on a tab without a panel does what a click on the add-on's
  // toolbar button would: the add-on's action.onClicked listeners run for that
  // tab, and give it its panel.
  var PANEL_STATE_KEY = "__sidePanelShim";
  var PANEL_EVENT_KEY = "__sidePanelShim:event";
  // The panel each tab was given, in storage.session: every page of the add-on
  // reads it, and it ends with the browser session, as tab IDs do.
  var PANEL_TAB_KEY = "__sidePanelShim:tab:";
  // Runtime messages from the sidebar page to the background.
  var PANEL_MSG_KEY = "__sidePanelShim:message";

  function installSidePanel() {
    // Chrome defines chrome.sidePanel only with the sidePanel permission, and
    // code tests for it: `if (chrome.sidePanel) open() else openWindow()`.
    if (!isExtensionPage || !CONFIG.sidePanel) return;
    var sidebar = api.sidebarAction || null;
    if (!sidebar && !api.windows) return;

    // Kept in localStorage: it is shared by all the extension's pages, and it is
    // synchronous, which matters because the action-click handler has to call
    // sidebarAction before it returns.
    var memory = { behavior: false, enabled: true, path: "" };
    function panelState() {
      var s = readLocal(PANEL_STATE_KEY);
      return s && typeof s === "object" ? s : memory;
    }
    function updatePanelState(change) {
      var s = panelState();
      var next = { behavior: !!s.behavior, enabled: s.enabled !== false, path: s.path || "" };
      change(next);
      memory = next;
      writeLocal(PANEL_STATE_KEY, next);
    }
    var tabOptions = {};
    var panelWindowId = null;

    var manifestPanel = "";
    try {
      var sa = api.runtime.getManifest().sidebar_action;
      manifestPanel = (sa && typeof sa.default_panel === "string") ? stripSlashes(sa.default_panel) : "";
    } catch (e) {}
    var defaultPath = stripSlashes(CONFIG.sidePanelPath || manifestPanel.split(/[?#]/)[0]);

    // A page whose docked form only works in Chrome carries the query that
    // selects its window form (CONFIG.panelQuery, derived from the bundle or
    // given with --panel-query). The query's keys are added to a path to the
    // panel page that doesn't set them itself.
    var panelQuery = String(CONFIG.panelQuery || "").replace(/^\?/, "");
    function withPanelQuery(path) {
      var p = stripSlashes(path);
      if (!panelQuery || !defaultPath) return p;
      var hash = p.indexOf("#");
      var page = hash < 0 ? p : p.slice(0, hash);
      var q = page.indexOf("?");
      if ((q < 0 ? page : page.slice(0, q)) !== defaultPath) return p;
      var query = q < 0 ? "" : page.slice(q + 1);
      var have = query.split("&").map(function (kv) { return kv.split("=")[0]; });
      var add = panelQuery.split("&").filter(function (kv) { return kv && have.indexOf(kv.split("=")[0]) < 0; });
      if (!add.length) return p;
      return page + (q < 0 ? "?" : /[?&]$/.test(page) ? "" : "&") + add.join("&") + (hash < 0 ? "" : p.slice(hash));
    }
    // The default page keeps the query the converter put on default_panel.
    function panelUrl(path) {
      var p = stripSlashes(path);
      if (manifestPanel && p === defaultPath && manifestPanel.split(/[?#]/)[0] === p) return extensionUrl(manifestPanel);
      return extensionUrl(withPanelQuery(p));
    }
    function reportedPath(url) {
      var rel = relativePath(url);
      if (!rel || (manifestPanel && rel === manifestPanel)) return defaultPath;
      return rel;
    }
    function enabledFor(tabId) {
      var t = tabId != null ? tabOptions[tabId] : null;
      if (t && typeof t.enabled === "boolean") return t.enabled;
      return panelState().enabled !== false;
    }
    function pathFor(tabId) {
      var t = tabId != null ? tabOptions[tabId] : null;
      return (t && t.path) || panelState().path || defaultPath;
    }
    function openWindow(path) {
      if (!path) return Promise.reject(new Error("No side panel page is set; call sidePanel.setOptions({ path }) first."));
      return Promise.resolve(api.windows.create({ url: panelUrl(path), type: "popup", width: 420, height: 720 }))
        .then(function (w) { panelWindowId = w && w.id != null ? w.id : null; });
    }
    function isOpenIn(tabId, windowId) {
      if (typeof sidebar.isOpen !== "function") return Promise.resolve(false);
      var win = windowId != null ? Promise.resolve(windowId)
        : tabId != null && api.tabs ? Promise.resolve(api.tabs.get(tabId)).then(function (t) { return t ? t.windowId : undefined; })
        : Promise.resolve(undefined);
      return win.then(function (w) {
        return sidebar.isOpen(w != null ? { windowId: w } : {});
      }).then(Boolean, function () { return false; });
    }
    function showPanel(tabId, windowId) {
      if (!sidebar) return openWindow(pathFor(tabId));
      // sidebarAction.open() only works inside a user action, so it must be
      // called before this returns; nothing may be awaited first. Outside one
      // Firefox refuses it even when the sidebar is already open, where
      // Chrome's open() succeeds.
      var opening;
      try { opening = sidebar.open(); } catch (e) { opening = Promise.reject(e); }
      return Promise.resolve(opening).catch(function (err) {
        return isOpenIn(tabId, windowId).then(function (open) { if (!open) throw err; });
      });
    }

    // Whether Chrome shows a panel on tabs the add-on gave none: its manifest
    // declares one, or its code set one for all tabs.
    function hasDefaultPanel() {
      return !CONFIG.noDefaultPanel || !!panelState().path;
    }
    var session = null;
    if (CONFIG.noDefaultPanel && sidebar) {
      try { session = (api.storage && api.storage.session) || null; } catch (e) {}
    }
    function rememberTabPanel(tabId, url) {
      if (!session) return undefined;
      var o = {};
      o[PANEL_TAB_KEY + tabId] = url;
      return Promise.resolve(session.set(o)).catch(noop);
    }
    // The panel the add-on gave a tab: its URL, null for none, or undefined
    // when that can't be known (no storage.session).
    function tabPanel(tabId) {
      if (!session) return Promise.resolve(undefined);
      var key = PANEL_TAB_KEY + tabId;
      return Promise.resolve(session.get(key)).then(function (r) {
        return r && typeof r[key] === "string" ? r[key] : null;
      }, function () { return undefined; });
    }

    var actionListening = false;
    // Toggles the panel on a click when openPanelOnActionClick is on.
    function toggleOnClick() {
      if (!panelState().behavior) return;
      try {
        var p = sidebar ? (typeof sidebar.toggle === "function" ? sidebar.toggle() : sidebar.open()) : openWindow(pathFor(null));
        if (p && typeof p.catch === "function") p.catch(noop);
      } catch (e) {}
    }
    function listenForActionClicks() {
      if (!isBackground || actionListening) return;
      var action = api.action || api.browserAction;
      if (!action || !action.onClicked || typeof action.onClicked.addListener !== "function") return;
      actionListening = true;
      action.onClicked.addListener(toggleOnClick);
    }
    // An event page woken by an action click doesn't run setPanelBehavior again,
    // so the listener goes in at startup whenever the behaviour was turned on.
    if (panelState().behavior) listenForActionClicks();

    // The add-on's own action.onClicked listeners, for a sidebar that comes up
    // on a tab without a panel.
    var actionListeners = [];
    function recordActionListeners() {
      namespaces.forEach(function (ns) {
        var action = null;
        try { action = ns.action || ns.browserAction; } catch (e) {}
        var ev = action && action.onClicked;
        if (!ev || typeof ev.addListener !== "function") return;
        var add = ev.addListener;
        var remove = ev.removeListener;
        replaceMember(ev, "addListener", function (fn) {
          if (typeof fn === "function" && actionListeners.indexOf(fn) < 0) actionListeners.push(fn);
          return add.apply(ev, arguments);
        });
        replaceMember(ev, "removeListener", function (fn) {
          var i = actionListeners.indexOf(fn);
          if (i >= 0) actionListeners.splice(i, 1);
          return remove.apply(ev, arguments);
        });
      });
    }
    // What a click on the toolbar button in that window would do, for the tab
    // it shows. With openPanelOnActionClick Chrome opens the panel on a click
    // instead of telling the add-on, and there is no panel for the tab to open.
    function clickForTab(windowId, tabId) {
      var listeners = actionListeners.filter(function (fn) { return fn !== toggleOnClick; });
      if (!listeners.length || panelState().behavior || !api.tabs) return Promise.resolve(false);
      return Promise.resolve(api.tabs.get(tabId)).then(function (tab) {
        if (!tab || !tab.active || tab.windowId !== windowId) return false;
        dbg("sidePanel: the sidebar came up on tab", tabId, "which has no panel; running the toolbar button's listeners");
        listeners.forEach(function (fn) { invoke(fn, [tab, { button: 0, modifiers: [] }]); });
        return true;
      }, function () { return false; });
    }
    if (CONFIG.noDefaultPanel && sidebar) {
      if (isBackground) {
        recordActionListeners();
        hideInternalMessages(PANEL_MSG_KEY, function (message) {
          if (!message || typeof message !== "object" || message[PANEL_MSG_KEY] !== "openForTab") return undefined;
          return clickForTab(message.windowId, message.tabId);
        });
      } else {
        hideInternalMessages(PANEL_MSG_KEY, null);
      }
    }

    // In the sidebar of an add-on without a default panel (see above): keep the
    // page a tab's panel put up for the window's other tabs, or have the add-on
    // give the selected tab a panel when it has none.
    function settleSidebar(windowId) {
      if (windowId == null || windowId < 0 || !api.tabs) return;
      var here = loc.href;
      Promise.resolve(api.tabs.query({ active: true, windowId: windowId })).then(function (tabs) {
        var tab = tabs && tabs[0];
        if (!tab || tab.id == null) return undefined;
        return tabPanel(tab.id).then(function (own) {
          // Without a record, a page other than sidebar_action's counts as the tab's own.
          if (own === undefined) own = relativePath(here) === manifestPanel ? null : here;
          if (own === here) return sidebar.setPanel({ windowId: windowId, panel: here });
          // The tab has a panel of its own, which Firefox is about to show.
          if (own !== null) return undefined;
          var message = { windowId: windowId, tabId: tab.id };
          message[PANEL_MSG_KEY] = "openForTab";
          return api.runtime.sendMessage(message);
        });
      }).catch(function (e) { dbg("sidePanel: settling the sidebar failed:", errorMessage(e)); });
    }

    var opened = makeEvent();
    var closed = makeEvent();

    function build(ns) {
      return {
        open: function (options, cb) {
          var tabId = options && options.tabId;
          var p;
          try {
            if (!enabledFor(tabId)) {
              throw new Error("No active side panel for " + (tabId != null ? "tabId: " + tabId : "windowId: " + (options && options.windowId)));
            }
            p = showPanel(tabId, options && options.windowId);
          } catch (e) { p = Promise.reject(e); }
          return respond(ns, Promise.resolve(p).then(noop), cb);
        },
        close: function (options, cb) {
          var p;
          try {
            if (sidebar) p = sidebar.close();
            else if (panelWindowId != null) p = api.windows.remove(panelWindowId);
          } catch (e) { p = Promise.reject(e); }
          return respond(ns, Promise.resolve(p).then(noop), cb);
        },
        setOptions: function (options, cb) {
          var p;
          try {
            var o = options || {};
            var hasPath = typeof o.path === "string";
            if (o.tabId != null) {
              var t = tabOptions[o.tabId] || {};
              if (typeof o.enabled === "boolean") t.enabled = o.enabled;
              if (hasPath) t.path = stripSlashes(o.path);
              tabOptions[o.tabId] = t;
              if (sidebar && hasPath) {
                var url = panelUrl(o.path);
                // Recorded first: the sidebar page this puts up looks for it.
                var remembered = rememberTabPanel(o.tabId, url);
                p = Promise.all([remembered, sidebar.setPanel({ tabId: o.tabId, panel: url })]);
              }
            } else {
              updatePanelState(function (s) {
                if (typeof o.enabled === "boolean") s.enabled = o.enabled;
                if (hasPath) s.path = stripSlashes(o.path);
              });
              if (sidebar && hasPath) p = sidebar.setPanel({ panel: panelUrl(o.path) });
            }
            dbg("sidePanel.setOptions", JSON.stringify(o));
          } catch (e) { p = Promise.reject(e); }
          return respond(ns, Promise.resolve(p).then(noop), cb);
        },
        getOptions: function (options, cb) {
          if (typeof options === "function") { cb = options; options = {}; }
          var tabId = options && options.tabId;
          var enabled = enabledFor(tabId);
          // The path as the extension set it, without the query added for Firefox.
          var stored = tabId != null ? (tabOptions[tabId] && tabOptions[tabId].path) : panelState().path;
          var p;
          if (sidebar && !stored) {
            p = Promise.resolve(sidebar.getPanel(tabId != null ? { tabId: tabId } : {})).then(function (url) {
              var out = { enabled: enabled };
              var path = reportedPath(url);
              if (path) out.path = path;
              return out;
            });
          } else {
            var out = { enabled: enabled };
            var path = stored || pathFor(tabId);
            if (path) out.path = path;
            p = Promise.resolve(out);
          }
          return respond(ns, p, cb);
        },
        setPanelBehavior: function (behavior, cb) {
          var on = !!(behavior && behavior.openPanelOnActionClick);
          updatePanelState(function (s) { s.behavior = on; });
          if (on) listenForActionClicks();
          return respond(ns, Promise.resolve(), cb);
        },
        getPanelBehavior: function (cb) {
          return respond(ns, Promise.resolve({ openPanelOnActionClick: !!panelState().behavior }), cb);
        },
        getLayout: function (cb) {
          // Extensions can't read which side Firefox puts the sidebar on; it
          // starts out on the left.
          return respond(ns, Promise.resolve({ side: "left" }), cb);
        },
        onOpened: opened.event,
        onClosed: closed.event,
      };
    }
    namespaces.forEach(function (ns) { defineMissing(ns, "sidePanel", build(ns)); });

    // onOpened/onClosed: the sidebar's own document announces itself through a
    // localStorage write, which every other running page of the extension sees
    // as a "storage" event. A suspended background page misses it.
    try {
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("storage", function (e) {
          if (!e || e.key !== PANEL_EVENT_KEY || !e.newValue) return;
          var d = null;
          try { d = JSON.parse(e.newValue); } catch (err) { return; }
          if (!d) return;
          (d.type === "opened" ? opened : closed).dispatch({ path: d.path, windowId: d.windowId });
        });
      }
      if (sidebar && hasDocument && typeof document.addEventListener === "function") {
        document.addEventListener("DOMContentLoaded", function () {
          var views = [];
          try { views = api.extension.getViews({ type: "sidebar" }) || []; } catch (e) {}
          if (Array.prototype.indexOf.call(views, window) < 0) return;
          var info = { path: reportedPath(loc.href), windowId: -1 };
          var announce = function (type) {
            writeLocal(PANEL_EVENT_KEY, { type: type, path: info.path, windowId: info.windowId, t: Date.now() });
          };
          Promise.resolve(api.windows && api.windows.getCurrent ? api.windows.getCurrent() : null).then(function (w) {
            if (w && w.id != null) info.windowId = w.id;
          }, noop).then(function () {
            announce("opened");
            if (!hasDefaultPanel()) settleSidebar(info.windowId);
          });
          window.addEventListener("pagehide", function () { announce("closed"); });
        });
      }
    } catch (e) {}
  }

  // ── chrome.offscreen ────────────────────────────────────────────────────────
  // Firefox's event page is a real document, so the offscreen document is a
  // hidden iframe in it. The iframe is an extension page of its own: it has the
  // extension API and receives the background's runtime messages natively.
  var OFFSCREEN_REASONS = [
    "TESTING", "AUDIO_PLAYBACK", "IFRAME_SCRIPTING", "DOM_SCRAPING", "BLOBS", "DOM_PARSER", "USER_MEDIA",
    "DISPLAY_MEDIA", "WEB_RTC", "CLIPBOARD", "LOCAL_STORAGE", "WORKERS", "BATTERY_STATUS", "MATCH_MEDIA",
    "GEOLOCATION",
  ];

  function installOffscreen() {
    if (!CONFIG.offscreen || !isBackground || !hasDocument || typeof document.createElement !== "function") return;
    offscreenEmulated = true;
    var frame = null;
    var keepAlive = null;
    var Reason = {};
    OFFSCREEN_REASONS.forEach(function (r) { Reason[r] = r; });

    function removeFrame() {
      var f = frame;
      frame = null;
      if (keepAlive !== null) { clearInterval(keepAlive); keepAlive = null; }
      try { if (f && f.parentNode) f.parentNode.removeChild(f); } catch (e) {}
      recordOffscreen(null);
    }

    // For runtime.getContexts in the add-on's other pages. A new event page has
    // no frame, whatever the last one had. storage.session needs the storage
    // permission, so an add-on without it records in localStorage, which every
    // page of the add-on shares too.
    function recordOffscreen(url) {
      offscreenDocumentUrl = url;
      var session = offscreenSession();
      if (!session) {
        try { if (localStore) { if (url) localStore.setItem(OFFSCREEN_STATE_KEY, url); else localStore.removeItem(OFFSCREEN_STATE_KEY); } } catch (e) {}
        return;
      }
      try {
        var o = {};
        o[OFFSCREEN_STATE_KEY] = url;
        var r = url ? session.set(o) : session.remove(OFFSCREEN_STATE_KEY);
        if (r && typeof r.catch === "function") r.catch(noop);
      } catch (e) {}
    }
    recordOffscreen(null);

    function create(params) {
      return new Promise(function (resolve) {
        if (frame) throw new Error("Only a single offscreen document may be created.");
        var url = params && params.url;
        if (typeof url !== "string" || !url) throw new Error("offscreen.createDocument needs a url.");
        var abs = extensionUrl(url);
        var f = document.createElement("iframe");
        try { f.setAttribute("aria-hidden", "true"); } catch (e) {}
        try { f.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;left:-9999px;top:-9999px;"; } catch (e) {}
        var settled = false;
        // Chrome resolves once the document has finished its initial load; a page
        // that never fires load must not hang the caller forever.
        var timer = setTimeout(done, 10000);
        function done() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        }
        f.addEventListener("load", done);
        f.src = abs;
        (document.body || document.documentElement).appendChild(f);
        frame = f;
        recordOffscreen(abs);
        // Chrome keeps an offscreen document until it is closed, but Firefox
        // suspends an idle event page after 30 s, iframe included (cutting off
        // audio it is playing, say). An extension API call from the background
        // resets that idle timer.
        keepAlive = setInterval(function () {
          try {
            var r = api.runtime.getPlatformInfo();
            if (r && typeof r.catch === "function") r.catch(noop);
          } catch (e) {}
        }, 20000);
        dbg("offscreen document created:", abs);
      });
    }

    namespaces.forEach(function (ns) {
      defineMissing(ns, "offscreen", {
        Reason: Reason,
        createDocument: function (params, cb) { return respond(ns, create(params), cb); },
        closeDocument: function (cb) {
          var p = frame ? Promise.resolve(removeFrame()) : Promise.reject(new Error("No current offscreen document."));
          return respond(ns, p, cb);
        },
        hasDocument: function (cb) { return respond(ns, Promise.resolve(!!frame), cb); },
      });
    });
  }

  // ── chrome.identity ─────────────────────────────────────────────────────────
  // Firefox implements getRedirectURL and launchWebAuthFlow only. getAuthToken
  // runs Google's OAuth flow through launchWebAuthFlow with Firefox's loopback
  // redirect (http://127.0.0.1/mozoauth2/<id>), which Google accepts without a
  // verified domain. The add-on's OAuth client has to allow that redirect.
  var TOKEN_STORE_KEY = "__identityShimTokens";
  var PROFILE_SCOPE_RE = /^(?:email|openid|profile)$|userinfo\.(?:email|profile)$/;

  function installIdentity() {
    var targets = namespaces.filter(function (ns) {
      try { return !!ns.identity && typeof ns.identity.launchWebAuthFlow === "function"; } catch (e) { return false; }
    });
    if (!targets.length) return;
    var identity = (api.identity && typeof api.identity.launchWebAuthFlow === "function") ? api.identity : targets[0].identity;

    // Token cache in storage.session, so it outlives the event page the way
    // Chrome's cache outlives the service worker, and so the background and the
    // extension's pages share it. Read fresh on every call; updates go through a
    // queue so two flows finishing together don't drop each other's token.
    var memoryTokens = {};
    var inflight = {};
    var session = null;
    try { session = api.storage && api.storage.session; } catch (e) {}

    function loadTokens() {
      if (!session) return Promise.resolve(memoryTokens);
      return Promise.resolve(session.get(TOKEN_STORE_KEY)).then(function (r) {
        var stored = r && r[TOKEN_STORE_KEY];
        return stored && typeof stored === "object" ? stored : {};
      }, function () { return {}; });
    }
    var updates = Promise.resolve();
    function updateTokens(change) {
      var run = updates.then(loadTokens).then(function (tokens) {
        change(tokens);
        if (!session) return undefined;
        var o = {};
        o[TOKEN_STORE_KEY] = tokens;
        return session.set(o);
      });
      updates = run.catch(noop);
      return run;
    }

    // Firefox's getManifest() leaves out keys it doesn't know, oauth2 among them,
    // so read the packaged manifest.json.
    function oauthConfig() {
      var fromRuntime = null;
      try { fromRuntime = api.runtime.getManifest().oauth2; } catch (e) {}
      if (fromRuntime && fromRuntime.client_id) return Promise.resolve(fromRuntime);
      if (!nativeFetch) return Promise.reject(new Error("Invalid OAuth2 Client ID."));
      return nativeFetch(api.runtime.getURL("manifest.json")).then(function (r) { return r.json(); }).then(function (m) {
        if (!m || !m.oauth2 || !m.oauth2.client_id) throw new Error("Invalid OAuth2 Client ID.");
        return m.oauth2;
      });
    }

    function loopbackRedirect() {
      var host = new URL(identity.getRedirectURL()).hostname;
      return "http://127.0.0.1/mozoauth2/" + host.split(".")[0];
    }

    function redirectParams(redirect) {
      var u = new URL(String(redirect));
      var params = new URLSearchParams((u.hash || "").replace(/^#/, ""));
      if (!params.get("access_token") && !params.get("error")) params = new URLSearchParams((u.search || "").replace(/^\?/, ""));
      var out = {};
      params.forEach(function (v, k) { out[k] = v; });
      return out;
    }

    function requestToken(details) {
      var d = details || {};
      return Promise.all([oauthConfig(), loadTokens()]).then(function (res) {
        var cfg = res[0];
        var tokens = res[1];
        var scopes = (Array.isArray(d.scopes) && d.scopes.length ? d.scopes : (cfg.scopes || [])).map(String);
        var key = scopes.slice().sort().join(" ");
        var cached = tokens[key];
        if (cached && cached.expires - 60000 > Date.now()) return { token: cached.token, grantedScopes: cached.scopes };
        var interactive = d.interactive === true;
        // A silent flow fails where the user has to sign in, so an interactive
        // call never joins one: each kind shares only its own in-flight flow.
        var flowKey = (interactive ? "interactive " : "silent ") + key;
        if (inflight[flowKey]) return inflight[flowKey];
        var query = [
          "client_id=" + encodeURIComponent(cfg.client_id),
          "response_type=token",
          "redirect_uri=" + encodeURIComponent(loopbackRedirect()),
          "scope=" + encodeURIComponent(scopes.join(" ")),
          "include_granted_scopes=true",
        ];
        if (!interactive) query.push("prompt=none");
        if (d.account && d.account.id) query.push("login_hint=" + encodeURIComponent(d.account.id));
        var url = "https://accounts.google.com/o/oauth2/v2/auth?" + query.join("&");
        var flow = Promise.resolve(identity.launchWebAuthFlow({ url: url, interactive: interactive })).then(function (redirect) {
          var p = redirectParams(redirect);
          if (p.error) throw new Error("OAuth2 request failed: " + p.error + (p.error_description ? " (" + p.error_description + ")" : ""));
          if (!p.access_token) throw new Error("OAuth2 request failed: no access token in the redirect.");
          var granted = p.scope ? p.scope.split(/\s+/).filter(Boolean) : scopes;
          var entry = { token: p.access_token, scopes: granted, expires: Date.now() + (Number(p.expires_in) || 3600) * 1000 };
          dbg("identity: token issued for", key);
          return updateTokens(function (all) { all[key] = entry; }).then(null, noop).then(function () {
            return { token: p.access_token, grantedScopes: granted };
          });
        });
        inflight[flowKey] = flow;
        var clear = function () { delete inflight[flowKey]; };
        flow.then(clear, clear);
        return flow;
      });
    }

    function profileInfo() {
      return loadTokens().then(function (tokens) {
        var now = Date.now();
        var hit = null;
        Object.keys(tokens).forEach(function (k) {
          var t = tokens[k];
          if (!hit && t && t.expires > now && Array.isArray(t.scopes) && t.scopes.some(function (s) { return PROFILE_SCOPE_RE.test(s); })) hit = t;
        });
        var none = { email: "", id: "" };
        if (!hit || !nativeFetch) return none;
        return nativeFetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + hit.token } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (info) {
            return info ? { email: String(info.email || ""), id: String(info.sub || "") } : none;
          }, function () { return none; });
      });
    }

    var signInChanged = makeEvent();
    targets.forEach(function (ns) {
      var id = ns.identity;
      defineMissing(id, "getAuthToken", function (details, cb) {
        if (typeof details === "function") { cb = details; details = {}; }
        var p = requestToken(details);
        if (typeof cb === "function") {
          // Chrome hands a callback the token and the granted scopes separately.
          respond(ns, p.then(function (r) { return [r.token, r.grantedScopes]; }), cb, true);
          return undefined;
        }
        return p;
      });
      defineMissing(id, "removeCachedAuthToken", function (details, cb) {
        var token = details && details.token;
        return respond(ns, updateTokens(function (all) {
          Object.keys(all).forEach(function (k) { if (all[k] && all[k].token === token) delete all[k]; });
        }), cb);
      });
      defineMissing(id, "clearAllCachedAuthTokens", function (cb) {
        return respond(ns, updateTokens(function (all) {
          Object.keys(all).forEach(function (k) { delete all[k]; });
        }), cb);
      });
      defineMissing(id, "getProfileUserInfo", function (details, cb) {
        if (typeof details === "function") { cb = details; }
        return respond(ns, profileInfo(), cb);
      });
      // Firefox has no signed-in browser account to report on; the event exists
      // so registering a listener doesn't throw.
      defineMissing(id, "onSignInChanged", signInChanged.event);
    });
  }

  // ── favicons ────────────────────────────────────────────────────────────────
  // chrome://favicon/[size/16@2x/]<url> (MV2) and <extension>/_favicon/?pageUrl=<url>
  // (MV3) don't exist in Firefox. Served from the open tab's icon when the
  // context can see tabs, then the site's /favicon.ico, then a generic globe.
  // Only emitted for an add-on that references these URLs.
  var GLOBE_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABGklEQVR42t2XwQ2DMAxFGSEjeQRGYISM4FMvPTBCRsgIjMAIjMAI" +
    "bSoFyXLtEGhR3B6+BCa2H+QDSYe3e9dS3S8CuCRI8kmY5XPMXQkwJMWkx45iHvs1gNedzRWNueac+xEAkoJL1l5jPg7PAgShyEpi" +
    "g3K8CvDhKACSYn2O9QLQds4b0py19CS0Od8KjfkcmAF7Ng4YYCR5Ixu3C3DGcEeMWQQYiJGAic43CE8AmBd4/kLyVYAoDWLNaLwU" +
    "A+XmogbgSLJTAKYKgEkBEOvXNKEODxUAoeD6Nzh60RPnawBYAYAFgO2N8BIAXuh+LjQJ0HwKmpuw+WvY/ENk4lPc/Gdk4nfcfEFi" +
    "YklmYlFqYlluYmNiZmv2n7vjJ6glw8q4mX+0AAAAAElFTkSuQmCC";
  var GLOBE = "data:image/png;base64," + GLOBE_PNG_BASE64;

  function installFavicon() {
    if (!CONFIG.favicon) return;
    var chromeOrigin = CONFIG.extensionId ? "chrome-extension://" + String(CONFIG.extensionId).toLowerCase() : "";

    // The page URL a favicon URL asks about: null when `raw` isn't a favicon
    // URL, "" when it is one without a page.
    function faviconPage(raw) {
      if (typeof raw !== "string" || !raw) return null;
      var m = /^chrome:\/\/favicon2?\/(.*)$/i.exec(raw);
      if (m) {
        var rest = m[1];
        if (rest.charAt(0) === "?") {
          try { return new URLSearchParams(rest.slice(1)).get("pageUrl") || ""; } catch (e) { return ""; }
        }
        return rest.replace(/^(?:size\/[^/]+\/|iconurl\/|origin\/)+/i, "");
      }
      var u;
      try { u = new URL(raw, loc.href); } catch (e) { return null; }
      var origin = originOf(u).toLowerCase();
      if (origin !== ORIGIN.toLowerCase() && !(chromeOrigin && origin === chromeOrigin)) return null;
      if (!/^\/_favicon\/?$/.test(u.pathname)) return null;
      return u.searchParams.get("pageUrl") || "";
    }

    function siteIcon(page) {
      try {
        var u = new URL(page);
        return u.protocol === "http:" || u.protocol === "https:" ? originOf(u) + "/favicon.ico" : null;
      } catch (e) { return null; }
    }

    function tabIcon(page) {
      if (!page || !api.tabs || typeof api.tabs.query !== "function") return Promise.resolve(null);
      var target;
      try { target = new URL(page); } catch (e) { return Promise.resolve(null); }
      return Promise.resolve(api.tabs.query({})).then(function (tabs) {
        var exact = null;
        var sameSite = null;
        (tabs || []).forEach(function (t) {
          if (!t || !t.url || !/^(?:data|https?):/i.test(t.favIconUrl || "")) return;
          var tu;
          try { tu = new URL(t.url); } catch (e) { return; }
          if (tu.href === target.href) exact = exact || t.favIconUrl;
          else if (originOf(tu) === originOf(target)) sameSite = sameSite || t.favIconUrl;
        });
        return exact || sameSite;
      }, function () { return null; });
    }

    if (nativeFetch) {
      var globeResponse = function () {
        var bin = atob(GLOBE_PNG_BASE64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } });
      };
      var fetchIcon = function (page) {
        return tabIcon(page).then(function (icon) {
          var candidates = [icon, siteIcon(page)].filter(Boolean);
          var attempt = function (i) {
            if (i >= candidates.length) return globeResponse();
            return Promise.resolve().then(function () { return nativeFetch(candidates[i]); }).then(function (r) {
              return r && r.ok ? r : attempt(i + 1);
            }, function () { return attempt(i + 1); });
          };
          return attempt(0);
        });
      };
      var wrapped = function fetch(input) {
        var raw = typeof input === "string" ? input : (input && typeof input.url === "string" ? input.url : String(input));
        var page = faviconPage(raw);
        if (page === null) return nativeFetch.apply(G, arguments);
        return fetchIcon(page);
      };
      try { G.fetch = wrapped; } catch (e) {}
    }

    // Test-load a URL off-document. The <img> itself can't be watched for this:
    // the error from its original, unloadable favicon URL can still arrive after
    // its src was changed, and would read as the replacement failing.
    function probeImage(url) {
      return new Promise(function (resolve) {
        if (typeof Image !== "function") { resolve(true); return; }
        var probe = new Image();
        probe.onload = function () { resolve(true); };
        probe.onerror = function () { resolve(false); };
        probe.src = url;
      });
    }

    // The generic icon goes in right away; the first real icon that loads
    // replaces it, unless the page has re-pointed the image in the meantime.
    function fixImage(img) {
      var raw;
      try { raw = img.getAttribute("src"); } catch (e) { return; }
      var page = faviconPage(raw);
      if (page === null) return;
      img.src = GLOBE;
      tabIcon(page).then(function (icon) {
        var candidates = [icon, siteIcon(page)].filter(Boolean);
        var attempt = function (i) {
          if (i >= candidates.length) return;
          probeImage(candidates[i]).then(function (ok) {
            if (img.src !== GLOBE) return;
            if (ok) img.src = candidates[i];
            else attempt(i + 1);
          });
        };
        attempt(0);
      });
    }

    if (!hasDocument) return;
    function scan(node) {
      if (!node || node.nodeType !== 1) return;
      if (String(node.tagName).toUpperCase() === "IMG") fixImage(node);
      if (typeof node.getElementsByTagName === "function") {
        var list = node.getElementsByTagName("img");
        for (var i = 0; i < list.length; i++) fixImage(list[i]);
      }
    }
    // In the extension's own pages, catch favicon <img>s as they are added or
    // re-pointed, before they load. Web pages, where content scripts run, aren't
    // observed; the error listener below covers images a content script adds.
    try {
      if (isExtensionPage && typeof MutationObserver === "function") {
        new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var r = records[i];
            if (r.type === "attributes") {
              if (r.target && String(r.target.tagName).toUpperCase() === "IMG") fixImage(r.target);
            } else if (r.addedNodes) {
              for (var j = 0; j < r.addedNodes.length; j++) scan(r.addedNodes[j]);
            }
          }
        }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
      }
    } catch (e) {}
    // Images that slipped past fail to load. Load errors don't bubble, so listen
    // in the capture phase.
    try {
      if (typeof document.addEventListener === "function") {
        document.addEventListener("error", function (e) {
          var t = e && e.target;
          if (t && String(t.tagName).toUpperCase() === "IMG") fixImage(t);
        }, true);
      }
    } catch (e) {}
  }

  // ── ServiceWorkerGlobalScope ────────────────────────────────────────────────
  // A Chrome background is a service worker, and a bundle that shares code
  // between it and its pages asks where it runs:
  //   if ("ServiceWorkerGlobalScope" in globalThis) refreshHere();
  //   else await chrome.runtime.sendMessage({ type: "refresh" });
  // The converted background is an event page, which would take the second
  // branch and message itself, and no context receives its own messages. So the
  // background answers yes, while the extension's pages keep answering no, as in
  // Chrome. Only emitted for a bundle that asks.
  function installServiceWorkerScope() {
    if (!CONFIG.serviceWorkerScope || !isBackground || G.ServiceWorkerGlobalScope != null) return;
    var scope = function ServiceWorkerGlobalScope() { throw new TypeError("Illegal constructor."); };
    try {
      Object.defineProperty(scope, Symbol.hasInstance, { value: function (v) { return v === G; } });
      Object.defineProperty(G, "ServiceWorkerGlobalScope", { value: scope, writable: true, configurable: true });
    } catch (e) {}
    // The worker's branch may call skipWaiting(), which a page doesn't have.
    defineMissing(G, "skipWaiting", function () { return Promise.resolve(); });
  }

  // ── A worker's own localStorage ─────────────────────────────────────────────
  // A service worker has no localStorage or sessionStorage, so a bundle may
  // give itself one: `self.localStorage = polyfill`. In the event page both are
  // getter-only accessors, and the assignment throws in strict and module code,
  // ending the background there. The names the bundle assigns become plain
  // writable properties holding Firefox's storage, so reads still reach it
  // until the bundle replaces it. Only in the background of a converted worker.
  function installAssignableStorageGlobals() {
    var names = CONFIG.storageGlobalsAssigned;
    if (!isBackground || !Array.isArray(names)) return;
    names.forEach(function (name) {
      var desc = null;
      for (var o = G; o && !desc; o = Object.getPrototypeOf(o)) desc = Object.getOwnPropertyDescriptor(o, name) || null;
      if (!desc || typeof desc.get !== "function" || desc.set) return;
      var value;
      try { value = G[name]; } catch (e) {}
      try {
        Object.defineProperty(G, name, { value: value, writable: true, configurable: true, enumerable: desc.enumerable === true });
      } catch (e) { dbg("can't make " + name + " assignable:", errorMessage(e)); }
    });
  }

  // ── Service worker messaging ────────────────────────────────────────────────
  // A Chrome extension's pages reach its service worker through
  // navigator.serviceWorker (ready, controller, getRegistration), and the worker
  // reaches its pages through `clients` and the `message` event on its global.
  // Firefox runs no service worker for an add-on: its pages have no
  // navigator.serviceWorker, and the converted background is an event page with
  // no `clients`. Both ends are emulated on window.postMessage between the
  // add-on's pages and the event page, which share a process in Firefox:
  //   - postMessage to the worker wakes the event page when it is suspended and
  //     fires `message` on its global, the ports transferred and a WindowClient
  //     for the page as the source;
  //   - Client.postMessage fires `message` on the page's navigator.serviceWorker,
  //     queued until the page starts its messages, as in Chrome.
  // Chrome's worker controls the add-on's pages, so `controller` is the worker
  // and code posts to it there. A worker that handles `fetch` serves its pages'
  // requests, which the event page can't, so its pages get no controller
  // (CONFIG.serviceWorkerController is off) and code that reads `controller` as
  // "my requests went through the worker" asks the worker instead; `ready`
  // still gives it. clients.matchAll() lists every page of the add-on whatever
  // includeUncontrolled says.
  var SW_ENVELOPE = "__lavaductServiceWorkerMessage";

  function swScriptUrl() {
    return extensionUrl(CONFIG.serviceWorkerScript || "");
  }

  // postMessage(message, transfer) and postMessage(message, { transfer }).
  function transferList(arg) {
    if (Array.isArray(arg)) return arg;
    if (arg && typeof arg === "object" && Array.isArray(arg.transfer)) return arg.transfer;
    return [];
  }

  function envelope(direction, message) {
    var e = {};
    e[SW_ENVELOPE] = direction;
    e.message = message;
    return e;
  }

  function unwrapEnvelope(e, direction) {
    var d = null;
    try { d = e.origin === ORIGIN ? e.data : null; } catch (x) {}
    return d && typeof d === "object" && d[SW_ENVELOPE] === direction ? d : null;
  }

  // onfoo properties that add and remove one listener, like an EventTarget's own.
  function handlerProps(target, types, onSet) {
    types.forEach(function (type) {
      var current = null;
      function call(e) { return current && current.call(target, e); }
      Object.defineProperty(target, "on" + type, {
        configurable: true, enumerable: true,
        get: function () { return current; },
        set: function (fn) {
          target.removeEventListener(type, call);
          current = typeof fn === "function" ? fn : null;
          if (!current) return;
          target.addEventListener(type, call);
          if (onSet) onSet(type);
        },
      });
    });
  }

  // The worker and its registration, as Chrome gives them to the worker
  // (self.serviceWorker, self.registration) and to its pages (registration.active).
  function makeServiceWorker(post) {
    var worker = new EventTarget();
    handlerProps(worker, ["statechange", "error"]);
    Object.defineProperties(worker, {
      scriptURL: { value: swScriptUrl(), enumerable: true },
      state: { value: "activated", enumerable: true },
      postMessage: { value: post, writable: true, configurable: true },
    });
    return worker;
  }

  function makeRegistration(worker) {
    var reg = new EventTarget();
    handlerProps(reg, ["updatefound"]);
    Object.defineProperties(reg, {
      scope: { value: ORIGIN + "/", enumerable: true },
      installing: { value: null, enumerable: true },
      waiting: { value: null, enumerable: true },
      active: { value: worker, enumerable: true },
      updateViaCache: { value: "imports", enumerable: true },
      update: { value: function () { return Promise.resolve(reg); }, writable: true, configurable: true },
      unregister: { value: function () { return Promise.resolve(false); }, writable: true, configurable: true },
    });
    return reg;
  }

  // ExtendableEvent.waitUntil: Chrome keeps the worker alive until the promise
  // settles. Firefox suspends an event page that has made no extension API call
  // for 30 s, so one is made every 20 s meanwhile.
  function keepAliveUntil(promise) {
    var timer = setInterval(function () {
      try {
        var r = api.runtime.getPlatformInfo();
        if (r && typeof r.catch === "function") r.catch(noop);
      } catch (e) {}
    }, 20000);
    function stop() { clearInterval(timer); }
    Promise.resolve(promise).then(stop, stop);
  }

  function installServiceWorkerContainer() {
    if (!CONFIG.serviceWorkerClients || !isExtensionPage || isBackground || !hasDocument) return;
    try { if (typeof navigator === "undefined" || "serviceWorker" in navigator) return; } catch (e) { return; }
    if (typeof EventTarget !== "function" || typeof MessageEvent !== "function") return;

    // To the event page, in order. A suspended one is woken first; the message is
    // copied at the call, as postMessage does, so what it transfers is detached.
    var waking = null;
    function postToWorker(message, transfer) {
      var options = { targetOrigin: ORIGIN, transfer: transferList(transfer) };
      var bg = null;
      if (!waking) { try { bg = api.extension.getBackgroundPage(); } catch (e) {} }
      if (bg) {
        bg.postMessage(envelope("toWorker", message), options);
        return;
      }
      var copy = structuredClone({ m: message, t: options.transfer }, { transfer: options.transfer });
      var p = (waking || Promise.resolve()).then(function () {
        return api.runtime.getBackgroundPage();
      }).then(function (w) {
        if (w) w.postMessage(envelope("toWorker", copy.m), { targetOrigin: ORIGIN, transfer: copy.t });
      }).catch(function (e) {
        dbg("message to the service worker lost:", errorMessage(e));
      });
      waking = p;
      p.then(function () { if (waking === p) waking = null; });
    }

    var worker = makeServiceWorker(function postMessage(message, transfer) { postToWorker(message, transfer); });
    var registration = makeRegistration(worker);
    var container = new EventTarget();
    var queued = [];
    function startMessages() {
      var q = queued;
      queued = null;
      if (q) q.forEach(function (e) { container.dispatchEvent(e); });
    }
    handlerProps(container, ["message", "messageerror", "controllerchange"], function (type) {
      if (type === "message") startMessages();
    });
    function inScope(url) {
      return url === undefined || String(url).indexOf(ORIGIN + "/") === 0 || !/^[a-z][a-z0-9+.-]*:/i.test(String(url));
    }
    Object.defineProperties(container, {
      controller: { value: CONFIG.serviceWorkerController ? worker : null, enumerable: true },
      ready: { value: Promise.resolve(registration), enumerable: true },
      getRegistration: { value: function (url) { return Promise.resolve(inScope(url) ? registration : undefined); }, writable: true, configurable: true },
      getRegistrations: { value: function () { return Promise.resolve([registration]); }, writable: true, configurable: true },
      // The add-on's worker is registered already; anything else can't be.
      register: {
        value: function (url) {
          var href = "";
          try { href = new URL(String(url), loc.href).href.split(/[?#]/)[0]; } catch (e) {}
          if (href && href === swScriptUrl()) return Promise.resolve(registration);
          return Promise.reject(new TypeError("Firefox runs no service worker for an add-on's page: " + String(url)));
        },
        writable: true, configurable: true,
      },
      startMessages: { value: startMessages, writable: true, configurable: true },
    });
    // A document's messages start on their own once it has been parsed.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startMessages);
    else startMessages();

    window.addEventListener("message", function (e) {
      var d = unwrapEnvelope(e, "fromWorker");
      if (!d) return;
      e.stopImmediatePropagation();
      var evt = new MessageEvent("message", { data: d.message, origin: ORIGIN, ports: Array.prototype.slice.call(e.ports || []) });
      try { Object.defineProperty(evt, "source", { value: worker, enumerable: true, configurable: true }); } catch (x) {}
      if (queued) queued.push(evt);
      else container.dispatchEvent(evt);
    }, true);

    try {
      Object.defineProperty(navigator, "serviceWorker", { value: container, enumerable: true, configurable: true });
    } catch (e) {}
  }

  function installServiceWorkerClients() {
    if (!CONFIG.serviceWorkerClients || !isBackground || typeof WeakMap !== "function") return;
    var known = new WeakMap();

    function windowClient(win) {
      var client = known.get(win);
      if (client) return client;
      var id = "";
      try { id = crypto.randomUUID(); } catch (e) { id = String(Math.random()).slice(2); }
      client = {
        id: id,
        type: "window",
        postMessage: function (message, transfer) {
          var closed = true;
          try { closed = win.closed; } catch (e) {}
          if (!closed) win.postMessage(envelope("fromWorker", message), { targetOrigin: ORIGIN, transfer: transferList(transfer) });
        },
        // Brings the page's tab and window to the front.
        focus: function () {
          var tabs = null;
          try { tabs = win.browser.tabs; } catch (e) {}
          return Promise.resolve(tabs && tabs.getCurrent()).then(function (tab) {
            if (!tab) { win.focus(); return client; }
            return Promise.all([
              api.tabs.update(tab.id, { active: true }),
              api.windows && api.windows.update(tab.windowId, { focused: true }),
            ]).then(function () { return client; });
          });
        },
        navigate: function (url) {
          try { win.location.href = extensionUrl(url); } catch (e) { return Promise.reject(new TypeError(errorMessage(e))); }
          return Promise.resolve(client);
        },
      };
      // A frame of the event page (the offscreen document) is never on screen,
      // though its document says it is visible like the event page's own.
      function shown() { try { return win.top !== G; } catch (e) { return false; } }
      Object.defineProperties(client, {
        url: { enumerable: true, get: function () { try { return win.location.href; } catch (e) { return ""; } } },
        frameType: { enumerable: true, get: function () { try { return win.top === win ? "top-level" : "nested"; } catch (e) { return "none"; } } },
        focused: { enumerable: true, get: function () { try { return shown() && win.document.hasFocus(); } catch (e) { return false; } } },
        visibilityState: { enumerable: true, get: function () { try { return shown() ? win.document.visibilityState : "hidden"; } catch (e) { return "hidden"; } } },
      });
      known.set(win, client);
      return client;
    }

    // Every page of the add-on in this process, frames included (the offscreen
    // emulation's iframe among them), but not the event page itself.
    function windowClients() {
      var views = [];
      try { views = api.extension.getViews() || []; } catch (e) {}
      var out = [];
      for (var i = 0; i < views.length; i++) if (views[i] !== G) out.push(windowClient(views[i]));
      return out;
    }

    function findClient(id) {
      var list = windowClients();
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return undefined;
    }

    // Resolves with the new page's client once it has loaded, null for a page
    // that isn't the add-on's, as Chrome does.
    function openWindow(url) {
      var href = extensionUrl(url);
      return Promise.resolve(api.tabs.create({ url: href })).then(function (tab) {
        if (href.indexOf(ORIGIN + "/") !== 0 || !tab) return null;
        return new Promise(function (resolve) {
          var tries = 0;
          (function poll() {
            var views = [];
            try { views = api.extension.getViews({ tabId: tab.id }) || []; } catch (e) {}
            var w = views[0];
            var ready = false;
            try { ready = !!w && w.document.readyState === "complete"; } catch (e) {}
            if (ready) resolve(windowClient(w));
            else if (++tries > 200) resolve(null);
            else setTimeout(poll, 50);
          })();
        });
      });
    }

    defineMissing(G, "clients", {
      matchAll: function (options) {
        var type = (options && options.type) || "window";
        return Promise.resolve(type === "window" || type === "all" ? windowClients() : []);
      },
      get: function (id) { return Promise.resolve(findClient(id)); },
      openWindow: openWindow,
      claim: function () { return Promise.resolve(); },
    });

    // The pages' messages to the worker, as the worker gets them: the message
    // itself, the page as a WindowClient, and waitUntil. Chrome runs a worker's
    // script before it gets any event; a page that finds the event page still
    // loading its scripts has its messages held until they have all run.
    var held = hasDocument && document.readyState === "loading" ? [] : null;
    if (held) {
      document.addEventListener("DOMContentLoaded", function () {
        var q = held;
        held = null;
        q.forEach(function (e) { G.dispatchEvent(e); });
      });
    }
    G.addEventListener("message", function (e) {
      var d = unwrapEnvelope(e, "toWorker");
      if (!d) return;
      var source = null;
      try { if (e.source) source = windowClient(e.source); } catch (x) {}
      var evt = e;
      if (held) {
        e.stopImmediatePropagation();
        evt = new MessageEvent("message", { data: null, origin: ORIGIN, ports: Array.prototype.slice.call(e.ports || []) });
        held.push(evt);
      }
      try {
        Object.defineProperty(evt, "data", { value: d.message, enumerable: true, configurable: true });
        Object.defineProperty(evt, "source", { value: source, enumerable: true, configurable: true });
        Object.defineProperty(evt, "waitUntil", { value: keepAliveUntil, writable: true, configurable: true });
      } catch (x) {}
    }, true);
  }

  // ── self.registration / self.serviceWorker ──────────────────────────────────
  // A worker reads its own registration and state:
  //   self.registration.addEventListener("updatefound", …)
  //   if (self.serviceWorker?.state === "activated") queue.activate();
  // An event page has neither, so the first throws and the second never runs.
  // The background stands in for a worker that is already active: the state a
  // Chrome worker restarted after its install is in. No update ever arrives, so
  // the registration's events never fire. Its postMessage reaches the worker
  // itself, with the worker as the source, as in Chrome. Only emitted for a
  // bundle that reads them. A bundle with web push code gets the worker without
  // the registration (see PUSH_MANAGER_REF_RE in shim.ts): MetaMask boots on
  // `"activated" === self.serviceWorker.state` and carries Firebase's push code.
  function installServiceWorkerRegistration() {
    if (!CONFIG.serviceWorkerSelf || !isBackground || typeof EventTarget !== "function") return;
    var worker = makeServiceWorker(function postMessage(message, transfer) {
      var list = transferList(transfer);
      var copy = structuredClone({ m: message, t: list }, { transfer: list });
      setTimeout(function () {
        var ports = copy.t.filter(function (x) { return typeof MessagePort === "function" && x instanceof MessagePort; });
        var evt = new MessageEvent("message", { data: copy.m, origin: ORIGIN, ports: ports });
        try {
          Object.defineProperty(evt, "source", { value: worker, enumerable: true, configurable: true });
          Object.defineProperty(evt, "waitUntil", { value: keepAliveUntil, writable: true, configurable: true });
        } catch (e) {}
        G.dispatchEvent(evt);
      }, 0);
    });
    defineMissing(G, "serviceWorker", worker);
    if (CONFIG.serviceWorkerRegistration) defineMissing(G, "registration", makeRegistration(worker));
  }

  // ── The worker's install and activate events ───────────────────────────────
  // Chrome installs an extension's service worker when the extension is
  // installed or updated: the worker's script runs, `install` fires, then
  // `activate`, each waiting on the promises its handlers pass to waitUntil.
  // Workers boot from those events (MetaMask starts its app from `install`)
  // and call skipWaiting() in them. The event page gets no such events, and a
  // page has no skipWaiting, so both are given here: once per add-on version,
  // after the background's scripts have run, `install` and then `activate`
  // are dispatched on the global, oninstall and onactivate included. Without
  // localStorage nothing is dispatched, since the version can't be told apart
  // and an event page restarts every time it wakes. Only emitted for a bundle
  // that listens for them or calls skipWaiting().
  var SW_VERSION_KEY = "__lavaductServiceWorkerVersion";

  function installServiceWorkerLifecycle() {
    if (!CONFIG.serviceWorkerLifecycle || !isBackground) return;
    defineMissing(G, "skipWaiting", function skipWaiting() { return Promise.resolve(); });
    if (typeof G.addEventListener !== "function" || typeof G.dispatchEvent !== "function" || typeof Event !== "function") return;
    ["install", "activate"].forEach(function (type) {
      if (!("on" + type in G)) handlerProps(G, [type]);
    });
    if (!localStore) return;
    var version = "";
    try { version = String(api.runtime.getManifest().version || ""); } catch (e) {}
    var last = null;
    try { last = localStore.getItem(SW_VERSION_KEY); } catch (e) {}
    if (last === version) return;

    // An ExtendableEvent: resolves once every promise passed to waitUntil has
    // settled, and keeps the event page awake until then.
    function fire(type) {
      var pending = [];
      var evt = new Event(type);
      try {
        Object.defineProperty(evt, "waitUntil", {
          configurable: true, writable: true,
          value: function waitUntil(p) { pending.push(Promise.resolve(p).catch(noop)); },
        });
      } catch (e) {}
      try { G.dispatchEvent(evt); } catch (e) { dbg("worker " + type + " event failed:", errorMessage(e)); }
      var all = Promise.all(pending);
      if (pending.length) keepAliveUntil(all);
      return all;
    }
    function run() {
      try { localStore.setItem(SW_VERSION_KEY, version); } catch (e) {}
      fire("install").then(function () { return fire("activate"); });
    }
    if (hasDocument && document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
    else setTimeout(run, 0);
  }

  // ── The worker's location in Web Lock names ────────────────────────────────
  // In Chrome the background's `location` is its script's (/sw.js); the event
  // page's is /_generated_background_page.html. A worker that holds a lock named
  // after its own location for as long as it runs:
  //   navigator.locks.request(location.pathname, () => new Promise(() => {}))
  // lets its pages tell when it has stopped, by waiting on that lock under the
  // script's path. The event page would hold it under the generated page's name,
  // which no page waits on, so the pages' requests would go to a background that
  // Firefox has suspended. A lock named after the event page is taken under the
  // script's name instead, path or full URL alike.
  function installServiceWorkerLocks() {
    if (!CONFIG.serviceWorkerLocks || !isBackground || !CONFIG.serviceWorkerScript) return;
    var locks = null;
    try { locks = navigator.locks; } catch (e) {}
    if (!locks || typeof locks.request !== "function") return;
    var native = locks.request;
    var script = "/" + stripSlashes(CONFIG.serviceWorkerScript);
    var names = {};
    names[loc.pathname] = script;
    names[ORIGIN + loc.pathname] = ORIGIN + script;
    replaceMember(locks, "request", function (name) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof name === "string" && Object.prototype.hasOwnProperty.call(names, name)) args[0] = names[name];
      return native.apply(locks, args);
    });
  }

  // ── The worker's script in getManifest() ────────────────────────────────────
  // Firefox returns the converted manifest, whose background has scripts and no
  // service_worker. Bundles tell the worker from their pages by resolving that
  // script against their own location (Loom):
  //   new URL(getManifest().background.service_worker, location.origin).pathname === location.pathname
  // Without the key the background answers no and sends what it would handle
  // itself to itself with runtime.sendMessage, where nothing receives it. The
  // background is told its own page is the worker's script, so the check says
  // yes there; everywhere else the key is Chrome's, the worker's real script,
  // which navigator.serviceWorker.register() in the pages matches.
  function installServiceWorkerManifest() {
    if (!CONFIG.serviceWorkerManifest || !CONFIG.serviceWorkerScript) return;
    var script = isBackground ? stripSlashes(loc.pathname) : stripSlashes(CONFIG.serviceWorkerScript);
    namespaces.forEach(function (ns) {
      var rt = ns && ns.runtime;
      var native = rt && rt.getManifest;
      if (typeof native !== "function") return;
      replaceMember(rt, "getManifest", function () {
        var manifest = native.apply(rt, arguments);
        var bg = manifest && manifest.background;
        if (!bg || typeof bg !== "object" || typeof bg.service_worker === "string") return manifest;
        var copy = Object.assign({}, manifest);
        copy.background = Object.assign({}, bg, { service_worker: script });
        return copy;
      });
    });
  }

  // ── chrome://newtab and chrome://extensions/shortcuts ──────────────────────
  // tabs.create, tabs.update and windows.create refuse chrome:// URLs in Firefox
  // ("Illegal URL"), and about:newtab and about:home as well. A bundle that
  // opens Chrome's new tab page gets Firefox's, which tabs.create and
  // windows.create open when given no url. tabs.update can't navigate a tab to
  // it, except where the add-on overrides the new tab page itself: chrome://newtab
  // then shows the add-on's page, as it does in Chrome, in place and in
  // windows.create lists alike. Chrome's shortcuts page is Firefox's
  // commands.openShortcutSettings(), which opens about:addons there; the call
  // answers with the tab that ends up active. Only emitted for a bundle that
  // names these URLs.
  var NEW_TAB_RE = /^chrome:\/\/new-?tab(?:-page)?\/?$/i;
  var SHORTCUTS_RE = /^chrome:\/\/extensions\/(?:shortcuts|configureCommands)\/?$/i;

  function installChromeUrls() {
    if (!CONFIG.newTab && !CONFIG.shortcutsPage) return;
    var ownNewTab = CONFIG.newTabPage ? extensionUrl(CONFIG.newTabPage) : "";
    var isNewTab = function (u) { return !!CONFIG.newTab && typeof u === "string" && NEW_TAB_RE.test(u); };
    var isShortcuts = function (u) { return !!CONFIG.shortcutsPage && typeof u === "string" && SHORTCUTS_RE.test(u); };
    function fixed(props, inPlace) {
      var url = props.url;
      if (!isNewTab(url) && !(Array.isArray(url) && url.some(isNewTab))) return props;
      var copy = Object.assign({}, props);
      var rest = Array.isArray(url)
        ? (ownNewTab ? url.map(function (u) { return isNewTab(u) ? ownNewTab : u; }) : url.filter(function (u) { return !isNewTab(u); }))
        : (inPlace && ownNewTab ? ownNewTab : null);
      if (rest && (!Array.isArray(rest) || rest.length)) copy.url = rest;
      else delete copy.url;
      return copy;
    }
    // Called before anything is awaited, so a user action that opened the call
    // still counts. Answers with the about:addons tab Firefox opened, or the
    // active tab of the last focused window when the add-on can't see URLs.
    function openShortcuts(ns, cb) {
      var p;
      try { p = Promise.resolve(ns.commands.openShortcutSettings()); } catch (e) { p = Promise.reject(e); }
      p = p.then(function () {
        return api.tabs.query({});
      }).then(function (tabs) {
        var list = Array.isArray(tabs) ? tabs : [];
        var addons = list.filter(function (t) { return t && /^about:addons/.test(String(t.url || "")); });
        if (addons.length) return addons.filter(function (t) { return t.active; })[0] || addons[0];
        return Promise.resolve(api.tabs.query({ active: true, lastFocusedWindow: true })).then(function (t) { return t && t[0]; });
      });
      return respond(ns, p, cb);
    }
    function wrap(ns, obj, name, inPlace, shortcuts) {
      if (!obj || typeof obj[name] !== "function") return;
      var original = obj[name];
      var wrapped = function () {
        var args = Array.prototype.slice.call(arguments);
        for (var i = 0; i < args.length; i++) {
          if (!args[i] || typeof args[i] !== "object") continue;
          var commands = null;
          try { commands = ns.commands; } catch (e) {}
          if (shortcuts && isShortcuts(args[i].url) && commands && typeof commands.openShortcutSettings === "function") {
            return openShortcuts(ns, typeof args[args.length - 1] === "function" ? args[args.length - 1] : null);
          }
          args[i] = fixed(args[i], inPlace);
        }
        return original.apply(obj, args);
      };
      try { Object.defineProperty(obj, name, { value: wrapped, writable: true, configurable: true, enumerable: true }); } catch (e) {}
    }
    namespaces.forEach(function (ns) {
      wrap(ns, ns.tabs, "create", false, true);
      wrap(ns, ns.tabs, "update", true, true);
      wrap(ns, ns.windows, "create", false, false);
    });
  }

  // ── The add-on's Chrome origin on its own requests ─────────────────────────
  // Chrome sends every request an extension's own pages make with its
  // chrome-extension://<id> origin, and some backends allow the extension by
  // that name only: Firefox's moz-extension://<random uuid> origin gets a
  // WebSocket handshake refused, or a 403 "Not allowed by CORS". A session rule
  // gives the add-on's own requests (the initiator is this add-on, never a tab
  // or a content script) the Chrome origin they have in Chrome. Firefox applies
  // a modifyHeaders rule only to requests the add-on has host access to, and
  // those are the ones Firefox exempts from CORS, so the origin a server
  // reflects back never has to match. Requests to other hosts keep Firefox's
  // origin, and its CORS check passes as before.
  var BACKEND_ORIGIN_RULE_ID = 2147480001;

  function installBackendOrigin() {
    var dnr = api.declarativeNetRequest;
    if (!isBackground || !CONFIG.extensionId || !dnr || typeof dnr.updateSessionRules !== "function") return;
    var rule = {
      id: BACKEND_ORIGIN_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "origin", operation: "set", value: "chrome-extension://" + String(CONFIG.extensionId).toLowerCase() }],
      },
      condition: { initiatorDomains: [loc.host], resourceTypes: ["websocket", "xmlhttprequest", "other"] },
    };
    Promise.resolve(dnr.updateSessionRules({ removeRuleIds: [BACKEND_ORIGIN_RULE_ID], addRules: [rule] })).catch(function (e) {
      dbg("backend origin rule failed:", errorMessage(e));
    });
  }

  // ── declarativeNetRequest rules added at runtime ───────────────────────────
  // The converter adapts the static rulesets; rules the code adds get the same
  // treatment here. Firefox refuses the whole updateDynamicRules or
  // updateSessionRules call over one rule it can't take, so the rules it can't
  // evaluate the way Chrome does are left out and the rest still apply: rules on
  // response headers or top domains, a regexFilter only RE2 compiles, and a
  // redirect to a data: URL. Chrome's old domains/excludedDomains names are
  // renamed, IPv6 addresses in domain lists get the brackets Firefox wants, and
  // the webbundle/webtransport request types, which Firefox never makes, are
  // taken out of a rule's types.
  var DNR_MISSING_CONDITIONS = ["responseHeaders", "excludedResponseHeaders", "topDomains", "excludedTopDomains"];
  var DNR_RENAMED_CONDITIONS = [["domains", "initiatorDomains"], ["excludedDomains", "excludedInitiatorDomains"]];
  var DNR_DOMAIN_CONDITIONS = ["requestDomains", "excludedRequestDomains", "initiatorDomains", "excludedInitiatorDomains"];
  var DNR_MISSING_TYPES = { webbundle: true, webtransport: true };

  // Chrome's extension ID is the host of its own origin, so code names it in a
  // rule's domains to mean its own requests: initiatorDomains: [chrome.runtime.id].
  // Firefox's add-on ID isn't a domain, and its pages' host is a per-install
  // UUID, so the add-on's ID, and its Chrome ID written into the code, become
  // that host.
  var OWN_HOST = "";
  try { OWN_HOST = new URL(ORIGIN + "/").host; } catch (e) {}
  var ownIds = {};
  try { ownIds[String(api.runtime.id).toLowerCase()] = true; } catch (e) {}
  if (CONFIG.extensionId) ownIds[String(CONFIG.extensionId).toLowerCase()] = true;

  // Chrome lower-cases a rule's domains, and Firefox refuses an upper-case one.
  function firefoxDomain(d) {
    if (typeof d !== "string") return d;
    var lower = d.toLowerCase();
    if (OWN_HOST && ownIds[lower] === true) return OWN_HOST;
    if (lower.indexOf(":") < 0 || lower.charAt(0) === "[") return lower;
    try { return new URL("http://[" + lower + "]/").hostname; } catch (e) { return d; }
  }

  // Chrome takes any ASCII string as a rule's domain and matches it against the
  // request's host, so an entry that is no host name just never matches: Total
  // Adblock excludes `${chrome.runtime.id}*`. Firefox refuses the whole call over
  // such an entry (its canonicalDomain format: the string must be the host name
  // a URL makes of it), and the add-on's ID with its '@' never is one. Those
  // entries are left out; non-ASCII ones stay, as Chrome refuses those too. Keep
  // identical to inertDomain in src/manifest/dnr.ts, which does it for static rules.
  function inertDomain(d) {
    if (typeof d !== "string" || !/^[\x00-\x7f]*$/.test(d)) return false;
    try { return new URL("http://" + d + "/").hostname !== d; } catch (e) { return true; }
  }

  // The rule as Firefox takes it, or null when it can't.
  function firefoxRule(rule) {
    if (!rule || typeof rule !== "object") return rule;
    var out = rule;
    var c = rule.condition;
    if (c && typeof c === "object") {
      for (var i = 0; i < DNR_MISSING_CONDITIONS.length; i++) if (DNR_MISSING_CONDITIONS[i] in c) return null;
      var cond = {};
      var keys = Object.keys(c);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var value = c[key];
        DNR_RENAMED_CONDITIONS.forEach(function (pair) { if (key === pair[0] && !(pair[1] in c)) key = pair[1]; });
        if ((key === "resourceTypes" || key === "excludedResourceTypes") && Array.isArray(value)) {
          var left = value.filter(function (t) { return DNR_MISSING_TYPES[t] !== true; });
          // Emptied, the list would match every type, while the rule only ever
          // targeted requests Firefox doesn't make.
          if (key === "resourceTypes" && value.length && !left.length) return null;
          value = left;
        }
        if (DNR_DOMAIN_CONDITIONS.indexOf(key) >= 0 && Array.isArray(value)) {
          var domains = value.map(firefoxDomain).filter(function (d) { return !inertDomain(d); });
          // A list of nothing but such entries matches no request in Chrome, so
          // the rule never applies there; empty, Firefox would apply it everywhere.
          if ((key === "requestDomains" || key === "initiatorDomains") && value.length && !domains.length) return null;
          value = domains;
        }
        cond[key] = value;
      }
      if (typeof cond.regexFilter === "string") {
        try { new RegExp(cond.regexFilter, cond.isUrlFilterCaseSensitive === true ? "" : "i"); } catch (e) { return null; }
      }
      out = Object.assign({}, rule, { condition: cond });
    }
    var redirect = out.action && out.action.redirect;
    if (redirect && typeof redirect.url === "string" && /^data:/i.test(redirect.url)) return null;
    return out;
  }

  // The session rules lavaduct adds for itself: the backend Origin rule, and
  // the frame grants' rules just above it (frame-grants-bg.js). An add-on that
  // clears every session rule at startup (getSessionRules, then removeRuleIds
  // of all of them, as Requestly does) or numbers its rules after the highest
  // one it sees would take them out or collide with them, so with
  // CONFIG.reservedSessionRules the add-on's getSessionRules leaves them out
  // and its removeRuleIds can't name them. The frame grants reach Firefox's
  // own methods through __lavaductNative on the wrappers.
  function isShimRule(id) {
    return id === BACKEND_ORIGIN_RULE_ID || (id >= 2147480100 && id < 2147480200);
  }

  function installRuleFilter() {
    namespaces.forEach(function (ns) {
      var dnr = null;
      try { dnr = ns.declarativeNetRequest; } catch (e) {}
      if (!dnr || typeof dnr !== "object") return;
      var hide = CONFIG.reservedSessionRules === true;
      ["updateDynamicRules", "updateSessionRules"].forEach(function (name) {
        var native = dnr[name];
        if (typeof native !== "function") return;
        var wrapper = function (options) {
          var args = Array.prototype.slice.call(arguments);
          if (options && typeof options === "object" && Array.isArray(options.addRules)) {
            var rules = [];
            options.addRules.forEach(function (r) {
              var adapted = firefoxRule(r);
              if (adapted) rules.push(adapted);
              else dbg("declarativeNetRequest." + name + ": left out a rule Firefox can't take:", r && r.id);
            });
            args[0] = Object.assign({}, options, { addRules: rules });
          }
          if (hide && name === "updateSessionRules" && args[0] && typeof args[0] === "object" && Array.isArray(args[0].removeRuleIds)) {
            args[0] = Object.assign({}, args[0], { removeRuleIds: args[0].removeRuleIds.filter(function (id) { return !isShimRule(id); }) });
          }
          return native.apply(dnr, args);
        };
        if (hide && name === "updateSessionRules") {
          try { Object.defineProperty(wrapper, "__lavaductNative", { value: native }); } catch (e) {}
        }
        replaceMember(dnr, name, wrapper);
      });
      var getSession = dnr.getSessionRules;
      if (!hide || typeof getSession !== "function") return;
      var getWrapper = function () {
        var args = Array.prototype.slice.call(arguments);
        var cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
        var p = Promise.resolve(getSession.apply(dnr, args)).then(function (rules) {
          return Array.isArray(rules) ? rules.filter(function (r) { return !r || !isShimRule(r.id); }) : rules;
        });
        return respond(ns, p, cb);
      };
      try { Object.defineProperty(getWrapper, "__lavaductNative", { value: getSession }); } catch (e) {}
      replaceMember(dnr, "getSessionRules", getWrapper);
    });
  }

  // ── runtime.getContexts ─────────────────────────────────────────────────────
  // Firefox's ContextType has no OFFSCREEN_DOCUMENT and refuses a filter naming
  // it. Code asks for that type to learn whether its offscreen document exists,
  // which the offscreen emulation records in storage.session, or in
  // localStorage for an add-on without the storage permission. The background
  // that holds the document knows it without either.
  var OFFSCREEN_STATE_KEY = "__lavaductOffscreenDocument";
  var offscreenEmulated = false;
  var offscreenDocumentUrl = null;

  function offscreenSession() {
    try {
      var s = api.storage && api.storage.session;
      return s && typeof s.get === "function" ? s : null;
    } catch (e) { return null; }
  }

  function recordedOffscreen() {
    if (offscreenEmulated) return Promise.resolve(offscreenDocumentUrl);
    var session = offscreenSession();
    if (!session) {
      var url = null;
      try { url = localStore && localStore.getItem(OFFSCREEN_STATE_KEY); } catch (e) {}
      return Promise.resolve(url || null);
    }
    return Promise.resolve().then(function () { return session.get(OFFSCREEN_STATE_KEY); }).then(function (got) {
      return (got && got[OFFSCREEN_STATE_KEY]) || null;
    }, function () { return null; });
  }

  function installGetContexts() {
    if (!CONFIG.offscreen) return;
    var nativeRuntime = api.runtime;
    var native = nativeRuntime && nativeRuntime.getContexts;
    if (typeof native !== "function") return;
    namespaces.forEach(function (ns) {
      var rt = null;
      try { rt = ns.runtime; } catch (e) {}
      if (!rt || typeof rt.getContexts !== "function") return;
      // Firefox's ContextType object has no OFFSCREEN_DOCUMENT, so a filter built
      // from Chrome's enum would hand Firefox [undefined].
      var contextType = null;
      try { contextType = rt.ContextType; } catch (e) {}
      if (contextType && typeof contextType === "object") defineMissing(contextType, "OFFSCREEN_DOCUMENT", "OFFSCREEN_DOCUMENT");
      else defineMissing(rt, "ContextType", { BACKGROUND: "BACKGROUND", POPUP: "POPUP", SIDE_PANEL: "SIDE_PANEL", TAB: "TAB", OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" });
      replaceMember(rt, "getContexts", function (filter, cb) {
        var types = filter && Array.isArray(filter.contextTypes) ? filter.contextTypes : null;
        var wantsOffscreen = !types || types.indexOf("OFFSCREEN_DOCUMENT") >= 0;
        var rest = types ? types.filter(function (t) { return t !== "OFFSCREEN_DOCUMENT"; }) : null;
        var nativeFilter = types ? Object.assign({}, filter, { contextTypes: rest }) : filter || {};
        var found = types && !rest.length ? Promise.resolve([]) : native.call(nativeRuntime, nativeFilter);
        var offscreen = wantsOffscreen ? recordedOffscreen() : Promise.resolve(null);
        var p = Promise.all([found, offscreen]).then(function (r) {
          var list = r[0] || [];
          var url = r[1];
          if (!url) return list;
          var ctx = {
            contextType: "OFFSCREEN_DOCUMENT", contextId: "offscreen-document", tabId: -1, windowId: -1,
            frameId: -1, documentId: "offscreen-document", documentUrl: url, documentOrigin: ORIGIN, incognito: false,
          };
          var matches = !filter || Object.keys(filter).every(function (key) {
            if (key === "contextTypes") return true;
            var want = filter[key];
            if (typeof want === "boolean") return ctx[key] === want;
            return !Array.isArray(want) || want.indexOf(ctx[key.replace(/s$/, "")]) >= 0;
          });
          return matches ? list.concat([ctx]) : list;
        });
        return respond(ns, p, cb);
      });
    });
  }

  // ── Chrome's enum objects ───────────────────────────────────────────────────
  // Chrome gives each enum type in its API an object of the values, keyed in
  // upper snake case, and extensions build their arguments from it:
  //   action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS }
  // Firefox makes that object only for the types its own schemas name, keyed by
  // the value upper-cased as it stands (SYNTAXERROR where Chrome has
  // SYNTAX_ERROR), and its declarativeNetRequest names no RuleActionType,
  // HeaderOperation, RequestMethod or DomainType. RuleActionType.MODIFY_HEADERS
  // then throws, and whatever builds a rule that way fails before Firefox sees
  // the rule. These are Chrome's, with the values both browsers take: defined
  // where Firefox has no object, and their keys added where Firefox spells them
  // otherwise.
  var CHROME_ENUMS = {
    declarativeNetRequest: {
      DomainType: ["firstParty", "thirdParty"],
      HeaderOperation: ["append", "set", "remove"],
      RequestMethod: ["connect", "delete", "get", "head", "options", "patch", "post", "put", "other"],
      RuleActionType: ["block", "redirect", "allow", "upgradeScheme", "modifyHeaders", "allowAllRequests"],
      UnsupportedRegexReason: ["syntaxError", "memoryLimitExceeded"],
    },
    identity: {
      AccountStatus: ["SYNC", "ANY"],
    },
    // Firefox's has INSTALL, UPDATE and BROWSER_UPDATE. Chrome code compares a
    // repeat with OnInstalledReason.CHROME_UPDATE, the reason the onInstalled
    // wrapper gives a temporary add-on loaded again.
    runtime: {
      OnInstalledReason: ["install", "update", "chrome_update", "shared_module_update"],
    },
    storage: {
      AccessLevel: ["TRUSTED_AND_UNTRUSTED_CONTEXTS", "TRUSTED_CONTEXTS"],
    },
  };

  // Chrome's key for a value: camelCase words and dashes are split by underscores.
  function chromeEnumKey(value) {
    return value.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/-/g, "_").toUpperCase();
  }

  function installEnums() {
    Object.keys(CHROME_ENUMS).forEach(function (area) {
      var types = CHROME_ENUMS[area];
      namespaces.forEach(function (ns) {
        var target = null;
        try { target = ns[area]; } catch (e) {}
        if (!target || typeof target !== "object") return;
        Object.keys(types).forEach(function (type) {
          var values = types[type];
          var existing = null;
          try { existing = target[type]; } catch (e) {}
          if (existing && typeof existing === "object") {
            values.forEach(function (v) { defineMissing(existing, chromeEnumKey(v), v); });
            return;
          }
          var obj = {};
          values.forEach(function (v) { obj[chromeEnumKey(v)] = v; });
          defineMissing(target, type, obj);
        });
      });
    });
  }

  // ── storage.session.setAccessLevel, and the area where Firefox has none ─────
  // Firefox's session area has no setAccessLevel and is never open to content
  // scripts. Code waiting on the call's callback would wait forever, so the call
  // settles here (Grammarly's background hangs without it).
  //
  // Code that finds setAccessLevel, though, keeps in the session area what its
  // content scripts read once it opens the area to them with
  // TRUSTED_AND_UNTRUSTED_CONTEXTS: Vimium's key mappings. Firefox gives no
  // session area to the add-on's own pages either when they are framed in a web
  // page (Vimium's Vomnibar and HUD), which Chrome treats as trusted. So for an
  // add-on whose code calls setAccessLevel (CONFIG.sessionAccess), a content
  // script or page without storage.session gets Chrome's as a stand-in whose
  // calls the background answers over an internal message, and its changes as
  // storage.session.onChanged and storage.onChanged with areaName "session".
  // As in Chrome, content scripts are refused until the background raises the
  // access level, which it does at each start (the level lives in the
  // background's memory, Chrome's for the browser session); the add-on's pages
  // never are.
  var ACCESS_LEVELS = ["TRUSTED_AND_UNTRUSTED_CONTEXTS", "TRUSTED_CONTEXTS"];
  var SESSION_MSG_KEY = "__lavaductSessionArea";
  var SESSION_OPS = ["get", "getKeys", "getBytesInUse", "set", "remove", "clear"];
  var SESSION_DENIED = "Access to storage is not allowed from this context.";
  var sessionLevel = "TRUSTED_CONTEXTS";

  function invalidAccessLevel(level) {
    return ACCESS_LEVELS.indexOf(level) >= 0 ? null : new Error("Invalid access level: " + level);
  }

  function installSessionAccessLevel() {
    var backfilled = false;
    namespaces.forEach(function (ns) {
      var session = null;
      try { session = ns.storage && ns.storage.session; } catch (e) {}
      if (!session) return;
      if (defineMissing(session, "setAccessLevel", function (details, cb) {
        var level = details && details.accessLevel;
        var err = invalidAccessLevel(level);
        if (!err && isBackground) sessionLevel = level;
        return respond(ns, err ? Promise.reject(err) : Promise.resolve(), cb);
      })) backfilled = true;
    });
    if (!CONFIG.sessionAccess) return;
    if (isBackground) {
      if (backfilled) answerSessionCalls();
      return;
    }
    installSessionStandIn();
  }

  function answerSessionCalls() {
    var area = api.storage.session;
    hideInternalMessages(SESSION_MSG_KEY, function (message, sender) {
      if (!message || message[SESSION_MSG_KEY] !== "call") return undefined;
      var op = message.op;
      var args = Array.isArray(message.args) ? message.args : [];
      var trusted = !!sender && typeof sender.url === "string" && !!ORIGIN && sender.url.indexOf(ORIGIN + "/") === 0;
      return new Promise(function (resolve) {
        if (op === "setAccessLevel") {
          if (!trusted) throw new Error(SESSION_DENIED);
          var level = args[0] && args[0].accessLevel;
          var err = invalidAccessLevel(level);
          if (err) throw err;
          sessionLevel = level;
          return resolve(undefined);
        }
        if (!trusted && sessionLevel !== "TRUSTED_AND_UNTRUSTED_CONTEXTS") throw new Error(SESSION_DENIED);
        if (SESSION_OPS.indexOf(op) < 0 || typeof area[op] !== "function") throw new Error("storage.session." + op + " is not available.");
        resolve(area[op].apply(area, args));
      }).then(function (value) {
        return { value: value };
      }, function (err) {
        return { error: errorMessage(err) };
      });
    });
    // The stand-ins hear the area's changes: the add-on's pages always, content
    // scripts while the area is open to them.
    var changed = null;
    try { changed = area.onChanged || null; } catch (e) {}
    var all = !changed;
    if (all) try { changed = api.storage.onChanged; } catch (e) {}
    if (!changed || typeof changed.addListener !== "function") return;
    changed.addListener(function (changes, areaName) {
      if (all && areaName !== "session") return;
      function message(to) {
        var m = {};
        m[SESSION_MSG_KEY] = "changed";
        m.to = to;
        m.changes = changes;
        return m;
      }
      try { Promise.resolve(api.runtime.sendMessage(message("pages"))).catch(noop); } catch (e) {}
      if (sessionLevel !== "TRUSTED_AND_UNTRUSTED_CONTEXTS" || !api.tabs) return;
      var toContent = message("content");
      Promise.resolve(api.tabs.query({})).then(function (tabs) {
        (tabs || []).forEach(function (tab) {
          try { Promise.resolve(api.tabs.sendMessage(tab.id, toContent)).catch(noop); } catch (e) {}
        });
      }).catch(noop);
    });
  }

  function installSessionStandIn() {
    var sessionEvent = makeEvent();
    // storage.onChanged listeners, for the changes Firefox never tells this
    // context about; the event itself stays Firefox's.
    var storageListeners = [];
    var defined = false;
    namespaces.forEach(function (ns) {
      var storage = null;
      try { storage = ns.storage; } catch (e) {}
      if (!storage) return;
      function call(op, args) {
        var message = {};
        message[SESSION_MSG_KEY] = "call";
        message.op = op;
        message.args = args;
        return Promise.resolve().then(function () { return api.runtime.sendMessage(message); }).then(function (reply) {
          if (!reply || typeof reply !== "object") throw new Error(SESSION_DENIED);
          if (reply.error) throw new Error(reply.error);
          return reply.value;
        });
      }
      var area = {
        QUOTA_BYTES: 10485760,
        onChanged: sessionEvent.event,
        setAccessLevel: function (details, cb) {
          return respond(ns, isExtensionPage ? call("setAccessLevel", [details]) : Promise.reject(new Error(SESSION_DENIED)), cb);
        },
      };
      SESSION_OPS.forEach(function (op) {
        area[op] = function () {
          var args = Array.prototype.slice.call(arguments);
          var cb = args.length && typeof args[args.length - 1] === "function" ? args.pop() : null;
          return respond(ns, call(op, args), cb);
        };
      });
      if (!defineMissing(storage, "session", area)) return;
      defined = true;
      var ev = null;
      try { ev = storage.onChanged; } catch (e) {}
      if (!ev || typeof ev.addListener !== "function") return;
      var add = ev.addListener, remove = ev.removeListener;
      replaceMember(ev, "addListener", function (fn) {
        if (typeof fn === "function" && storageListeners.indexOf(fn) < 0) storageListeners.push(fn);
        return add.apply(ev, arguments);
      });
      if (typeof remove === "function") {
        replaceMember(ev, "removeListener", function (fn) {
          var i = storageListeners.indexOf(fn);
          if (i >= 0) storageListeners.splice(i, 1);
          return remove.apply(ev, arguments);
        });
      }
    });
    var audience = isExtensionPage ? "pages" : "content";
    hideInternalMessages(SESSION_MSG_KEY, defined ? function (message) {
      if (!message || message[SESSION_MSG_KEY] !== "changed" || message.to !== audience || !message.changes) return undefined;
      sessionEvent.dispatch(message.changes);
      storageListeners.slice().forEach(function (fn) { invoke(fn, [message.changes, "session"]); });
      return undefined;
    } : null);
  }

  // ── window.chrome in content scripts ────────────────────────────────────────
  // A Firefox content script's globals live in a sandbox whose `window` is an
  // Xray to the page's window, so `chrome` resolves and `window.chrome` doesn't.
  // A property set on the Xray is seen by this add-on's content scripts only,
  // never by the page.
  function installWindowChrome() {
    if (isExtensionPage || typeof window !== "object" || !window || window === G) return;
    var ns = api;
    try { if (typeof chrome === "object" && chrome) ns = chrome; } catch (e) {}
    defineMissing(window, "chrome", ns);
  }

  // ── The add-on's ID in a CSS selector ──────────────────────────────────────
  // A Chrome ID is 32 letters from a to p, a CSS identifier, so code written for
  // Chrome puts chrome.runtime.id in selectors unquoted: Hypothesis's boot script
  // looks for `script.js-hypothesis-config[data-extension-id=<id>]`. Firefox's
  // runtime.id is the gecko ID (`<chromeId>.<salt>@lavaduct` for a converted
  // add-on), whose `.` and `@` make such a selector throw a SyntaxError; the
  // boot script died before injecting the sidebar. When querySelector,
  // querySelectorAll, matches, closest or webkitMatchesSelector throws one over
  // a selector holding the ID unquoted, the call is retried with the ID as a
  // CSS string where it is an attribute value, and escaped after `#` or `.`.
  // A selector that parses never reaches the retry. In a content script the
  // methods are defined on its Xrays of the prototypes, which the page never
  // sees. Emitted for an add-on whose code reads runtime.id and queries
  // selectors.
  function installOwnIdSelectors() {
    if (!CONFIG.ownIdSelectors || typeof window !== "object" || !window) return;
    var id = "";
    try { id = String(api.runtime.id || ""); } catch (e) {}
    if (!id || /^-?[A-Za-z_][\w-]*$/.test(id)) return;
    var literal = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var asValue = new RegExp("([~|^$*]?=\\s*)" + literal + "(?=\\s*(?:[iIsS]\\s*)?\\])", "g");
    var asName = new RegExp("([#.])" + literal + "(?![\\w\\u00A0-\\uFFFF-])", "g");
    var quoted = '"' + id.replace(/["\\]/g, "\\$&") + '"';
    var escaped = id.replace(/[^\w\u00A0-\uFFFF-]/g, "\\$&").replace(/^(-?)(\d)/, "$1\\3$2 ");
    function rewrite(selectors) {
      return selectors
        .replace(asValue, function (m, op) { return op + quoted; })
        .replace(asName, function (m, mark) { return mark + escaped; });
    }
    function wrap(proto, name) {
      var native = null;
      try { native = proto && proto[name]; } catch (e) {}
      if (typeof native !== "function") return;
      var wrapped = function (selectors) {
        try {
          return native.apply(this, arguments);
        } catch (e) {
          var kind = null;
          try { kind = e && e.name; } catch (x) {}
          var fixed = kind === "SyntaxError" && typeof selectors === "string" ? rewrite(selectors) : selectors;
          if (fixed === selectors) throw e;
          var args = Array.prototype.slice.call(arguments);
          args[0] = fixed;
          try { return native.apply(this, args); } catch (x) { throw e; }
        }
      };
      try { Object.defineProperty(wrapped, "name", { value: name, configurable: true }); } catch (e) {}
      replaceMember(proto, name, wrapped);
    }
    [
      ["Document", ["querySelector", "querySelectorAll"]],
      ["DocumentFragment", ["querySelector", "querySelectorAll"]],
      ["Element", ["querySelector", "querySelectorAll", "matches", "closest", "webkitMatchesSelector"]],
    ].forEach(function (entry) {
      var proto = null;
      try { proto = window[entry[0]] && window[entry[0]].prototype; } catch (e) {}
      if (proto) entry[1].forEach(function (name) { wrap(proto, name); });
    });
  }

  // ── CustomEvent detail between a content script and the page ───────────────
  // Chrome structured-clones a CustomEvent's detail for a listener in another
  // world, so an isolated content script hands the page (a world: "MAIN" script
  // or one it injected) plain objects. In Firefox the page gets the content
  // script's own object, and every property read throws "Permission denied to
  // access property". An event this world creates carries a clone in the page's
  // compartment instead; this world's listeners still read the object it passed,
  // through a `detail` getter defined on its Xray of CustomEvent.prototype, which
  // the page never sees. A detail cloneInto refuses (one holding a function) is
  // passed as before.
  function installPageEventDetail() {
    if (!CONFIG.pageEventDetail || isExtensionPage || typeof window !== "object" || !window || window === G) return;
    if (typeof cloneInto !== "function" || typeof WeakMap !== "function") return;
    var Native = window.CustomEvent;
    var proto = Native && Native.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, "detail");
    var nativeDetail = desc && desc.get;
    var nativeInit = proto && proto.initCustomEvent;
    if (typeof Native !== "function" || typeof nativeDetail !== "function") return;
    var originals = new WeakMap();
    function forPage(detail) {
      if (detail === null || (typeof detail !== "object" && typeof detail !== "function")) return detail;
      try { return cloneInto(detail, window, { wrapReflectors: true }); } catch (e) { return detail; }
    }
    function CustomEvent(type, eventInitDict) {
      // Without `new`, the native constructor throws its own TypeError.
      if (!(this instanceof CustomEvent)) return Native.apply(this, arguments);
      var init = eventInitDict;
      if (init === null || typeof init !== "object" || !("detail" in init)) return Reflect.construct(Native, arguments);
      var detail = init.detail;
      var page = forPage(detail);
      if (page === detail) return Reflect.construct(Native, arguments);
      var event = new Native(type, { bubbles: init.bubbles, cancelable: init.cancelable, composed: init.composed, detail: page });
      originals.set(event, detail);
      return event;
    }
    CustomEvent.prototype = proto;
    try { Object.setPrototypeOf(CustomEvent, Object.getPrototypeOf(Native)); } catch (e) {}
    Object.defineProperty(proto, "detail", {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () { return originals.has(this) ? originals.get(this) : nativeDetail.call(this); },
    });
    if (typeof nativeInit === "function") {
      Object.defineProperty(proto, "initCustomEvent", {
        configurable: true, enumerable: true, writable: true,
        value: function initCustomEvent(type, bubbles, cancelable, detail) {
          var page = forPage(detail);
          var result = nativeInit.call(this, type, bubbles, cancelable, page);
          if (page !== detail) originals.set(this, detail);
          else originals.delete(this);
          return result;
        },
      });
    }
    try { Object.defineProperty(proto, "constructor", { value: CustomEvent, writable: true, configurable: true }); } catch (e) {}
    Object.defineProperty(window, "CustomEvent", { value: CustomEvent, writable: true, configurable: true });
    Object.defineProperty(G, "CustomEvent", { value: CustomEvent, writable: true, configurable: true });
  }

  // ── json() bodies in content scripts ────────────────────────────────────────
  // A content script's Response and Request are the page's, seen through an
  // Xray, so json() builds its objects in the page's realm: their prototype is
  // the page's Object.prototype and arrays fail `instanceof Array`. Chrome's
  // isolated world gets objects of its own, and code that keeps only objects
  // whose prototype is Object.prototype drops the rest. json() reads the body
  // as text and parses it here instead, which is what it does in either
  // browser: UTF-8, the same SyntaxError, the same TypeError for a body already
  // read. The method lives on the Xray, so the page never sees it. Only emitted
  // for a bundle that calls json().
  function installContentBodyJson() {
    if (!CONFIG.contentBodyJson || isExtensionPage || typeof window !== "object" || !window || window === G) return;
    ["Response", "Request"].forEach(function (name) {
      var proto = null;
      try { proto = G[name] && G[name].prototype; } catch (e) {}
      if (!proto || typeof proto.json !== "function" || typeof proto.text !== "function") return;
      var text = proto.text;
      replaceMember(proto, "json", function json() {
        var body = this;
        return new Promise(function (resolve) { resolve(text.call(body)); }).then(function (t) { return JSON.parse(t); });
      });
    });
  }

  // ── browserAction in an MV3 add-on ──────────────────────────────────────────
  // Firefox gives an MV3 add-on `action` and no `browserAction`, as Chrome does.
  // A bundle that also ships to Firefox as MV2 picks its Firefox branch by user
  // agent, and that branch reads browserAction (Web Scraper: its toolbar button
  // opens the sidebar through browserAction.onClicked). The two are the same
  // API, so a bundle that reads browserAction's members gets `action` under
  // that name; Firefox's own browserAction (MV2) is kept.
  function installBrowserActionAlias() {
    if (!CONFIG.browserActionAlias) return;
    namespaces.forEach(function (ns) {
      var action = null;
      try { action = ns.action; } catch (e) {}
      if (action && typeof action === "object") defineMissing(ns, "browserAction", action);
    });
  }

  // ── The default cookie store without the cookies permission ────────────────
  // Firefox refuses any cookieStoreId from an add-on without the cookies
  // permission, the default store's included: tabs.create, windows.create and
  // downloads.download reject with "No permission for cookieStoreId:
  // firefox-default" and open nothing. A bundle that also ships to Firefox picks
  // its Firefox branch by user agent and passes a tab's saved store there (Tab
  // Session Manager restored every session as empty windows); its own Firefox
  // build declares cookies, the Chrome manifest doesn't. Leaving the default
  // store out lands in the same store, so a refused call is made again without
  // it, where that holds: not in a private window or download, where Firefox
  // refuses the default store either way, and not with an opener tab or an
  // adopted tab from another store, whose container leaving it out inherits.
  // Other stores keep Firefox's refusal.
  var DEFAULT_COOKIE_STORE = "firefox-default";

  function installDefaultCookieStore() {
    if (!CONFIG.defaultCookieStore) return;
    try {
      var perms = api.runtime.getManifest().permissions;
      if (Array.isArray(perms) && perms.indexOf("cookies") >= 0) return;
    } catch (e) {}
    var refused = "No permission for cookieStoreId: " + DEFAULT_COOKIE_STORE;
    function tabInDefault(id) {
      return Promise.resolve(api.tabs.get(id)).then(function (tab) { return !!tab && tab.cookieStoreId === DEFAULT_COOKIE_STORE; });
    }
    function normalWindow(win) {
      return !!win && win.incognito === false;
    }
    // Whether `props` without the store id opens in the default store too.
    var sameWithout = {
      "tabs.create": function (props) {
        if (props.openerTabId != null) return tabInDefault(props.openerTabId);
        if (props.windowId != null) return Promise.resolve(api.windows.get(props.windowId)).then(normalWindow);
        // Firefox opens it in the top normal window, never a private one for an
        // add-on kept out of private windows.
        var ext = api.extension;
        var allowed = ext && typeof ext.isAllowedIncognitoAccess === "function" ? ext.isAllowedIncognitoAccess() : true;
        return Promise.resolve(allowed).then(function (yes) {
          if (!yes) return true;
          return Promise.resolve(api.windows.getLastFocused()).then(function (win) { return normalWindow(win) && win.type === "normal"; });
        });
      },
      "windows.create": function (props) {
        if (props.incognito === true) return false;
        if (props.tabId != null) return tabInDefault(props.tabId);
        return true;
      },
      "downloads.download": function (props) {
        return props.incognito !== true;
      },
    };
    var targets = Object.keys(sameWithout).map(function (key) {
      var parts = key.split(".");
      var area = null;
      try { area = api[parts[0]]; } catch (e) {}
      var fn = area && area[parts[1]];
      return { key: key, area: parts[0], name: parts[1], self: area, call: typeof fn === "function" ? fn : null };
    });
    namespaces.forEach(function (ns) {
      targets.forEach(function (t) {
        if (!t.call) return;
        var obj = null;
        try { obj = ns[t.area]; } catch (e) {}
        if (!obj || typeof obj[t.name] !== "function") return;
        var original = obj[t.name];
        replaceMember(obj, t.name, function withDefaultCookieStore(props) {
          if (!props || typeof props !== "object" || props.cookieStoreId !== DEFAULT_COOKIE_STORE) return original.apply(obj, arguments);
          var cb = typeof arguments[arguments.length - 1] === "function" ? arguments[arguments.length - 1] : null;
          var p = Promise.resolve(t.call.call(t.self, props)).catch(function (err) {
            if (errorMessage(err) !== refused) throw err;
            return Promise.resolve().then(function () { return sameWithout[t.key](props); }).then(function (same) {
              if (same !== true) throw err;
              var rest = Object.assign({}, props);
              delete rest.cookieStoreId;
              return t.call.call(t.self, rest);
            }, function () { throw err; });
          });
          return respond(ns, p, cb);
        });
      });
    });
  }

  // ── webpack chunks of a worker bundle ──────────────────────────────────────
  // A webpack service worker loads an async chunk with importScripts, which runs
  // it synchronously, so startup code can require the chunk a microtask later.
  // The converter lists the chunks ahead of the worker instead, and each queues
  // its registration in the chunk array before webpack's runtime exists. That
  // runtime only installs chunks pushed after it takes over the array's push,
  // so the queued ones are handed to its push the moment it does.
  function installWorkerChunks() {
    var name = CONFIG.webpackChunkGlobal;
    if (!isBackground || typeof name !== "string" || !name) return;
    var queue = G[name];
    if (queue === undefined) G[name] = queue = [];
    if (!Array.isArray(queue)) return;
    var push = queue.push;
    Object.defineProperty(queue, "push", {
      configurable: true,
      get: function () { return push; },
      set: function (fn) {
        push = fn;
        if (typeof fn !== "function") return;
        queue.splice(0, queue.length).forEach(function (entry) { invoke(fn, [entry]); });
      },
    });
  }

  // ── USER_SCRIPT world ──────────────────────────────────────────────────────
  // With messaging on, Chrome's USER_SCRIPT world gets chrome.runtime with id
  // (a template property on every runtime object), lastError, sendMessage,
  // connect, onMessage and onConnect. Firefox gives it sendMessage and connect
  // only, so a script reading chrome.runtime.id gets undefined and one adding an
  // onMessage listener throws. Every USER_SCRIPT registration gets a first code
  // entry that fills in id and inert onMessage/onConnect events (Firefox never
  // delivers tabs.sendMessage to that world). It runs in the same world ahead of
  // the scripts, and changes nothing where messaging is off (no chrome.runtime).
  function userScriptWorldPrelude() {
    var id = JSON.stringify(String(api.runtime.id));
    return "(function(){try{var c=typeof chrome==='object'&&chrome||typeof browser==='object'&&browser;var r=c&&c.runtime;if(!r)return;" +
      "if(r.id==null)Object.defineProperty(r,'id',{value:" + id + ",enumerable:true,configurable:true});" +
      "var ev=function(){var l=[];return{addListener:function(f){if(l.indexOf(f)<0)l.push(f)},removeListener:function(f){var i=l.indexOf(f);if(i>=0)l.splice(i,1)},hasListener:function(f){return l.indexOf(f)>=0},hasListeners:function(){return l.length>0}}};" +
      "if(r.onMessage==null)r.onMessage=ev();if(r.onConnect==null)r.onConnect=ev();if(!('lastError' in r))r.lastError=undefined;}catch(e){}})();";
  }

  function withPrelude(script) {
    if (!script || typeof script !== "object" || script.world === "MAIN" || !Array.isArray(script.js)) return script;
    var copy = {};
    for (var k in script) copy[k] = script[k];
    copy.js = [{ code: userScriptWorldPrelude() }].concat(script.js);
    return copy;
  }

  // Chrome gives each code entry of a registered user script a URL of its own
  // inside the extension (chrome-extension://<id>/<random UUID>, in Chromium's
  // content_script_utils.cc ParseFileSources), so `import('./api.js')` or
  // `import('/api.js')` in it loads the extension's file. Firefox resolves the
  // specifier against the page instead (Surfingkeys' snippets asked
  // example.com for api.js). A string-literal relative or root-relative
  // specifier in a registered code entry becomes the add-on's absolute URL,
  // with the original kept beside it in a comment, so getScripts reports the
  // code as it was registered. Files and non-literal specifiers stay as they
  // are, and so does userScripts.execute, whose code Chrome gives no URL.
  var IMPORT_SPECIFIER_RE = /(^|[^\w$.])(import\s*\(\s*)(["'`])((?:\.{1,2}\/|\/(?!\/))[^"'`\\\r\n]*)\3/g;
  var RESOLVED_IMPORT_MARK = "/*lavaduct-import*/";
  var RESOLVED_IMPORT_RE = /\/\*lavaduct-import\*\/"[^"\\]*"\/\*([\s\S]*?)\*\//g;

  function extensionImportUrl(spec) {
    var m = /^([^?#]*)([\s\S]*)$/.exec(spec);
    var out = [];
    var segments = m[1].split("/");
    segments.forEach(function (seg, i) {
      if (seg === "..") out.pop();
      else if (seg !== "." && (seg !== "" || i === segments.length - 1)) out.push(seg);
    });
    return ORIGIN + "/" + out.join("/") + m[2];
  }

  function resolveCodeImports(code) {
    if (typeof code !== "string" || !ORIGIN || code.indexOf("import") < 0) return code;
    return code.replace(IMPORT_SPECIFIER_RE, function (all, before, call, quote, spec) {
      if (spec.indexOf("*/") >= 0 || (quote === "`" && spec.indexOf("${") >= 0)) return all;
      return before + call + RESOLVED_IMPORT_MARK + JSON.stringify(extensionImportUrl(spec)) + "/*" + quote + spec + quote + "*/";
    });
  }

  function registeredCodeImports(code) {
    return typeof code === "string" && code.indexOf(RESOLVED_IMPORT_MARK) >= 0 ? code.replace(RESOLVED_IMPORT_RE, "$1") : code;
  }

  // The script with fn applied to each of its code entries.
  function mapScriptCode(script, fn) {
    if (!script || typeof script !== "object" || !Array.isArray(script.js)) return script;
    var changed = false;
    var js = script.js.map(function (entry) {
      if (!entry || typeof entry.code !== "string") return entry;
      var code = fn(entry.code);
      if (code === entry.code) return entry;
      changed = true;
      var c = {}; for (var k in entry) c[k] = entry[k]; c.code = code; return c;
    });
    if (!changed) return script;
    var copy = {}; for (var key in script) copy[key] = script[key]; copy.js = js;
    return copy;
  }

  function forRegistration(script) {
    return withPrelude(mapScriptCode(script, resolveCodeImports));
  }

  var wrappedUserScripts = typeof WeakSet === "function" ? new WeakSet() : null;
  function wrapUserScripts(ns) {
    var us;
    try { us = ns.userScripts; } catch (e) { return; }
    if (!us || !wrappedUserScripts || wrappedUserScripts.has(us)) return;
    wrappedUserScripts.add(us);
    ["register", "update"].forEach(function (name) {
      var orig = us[name];
      if (typeof orig !== "function") return;
      replaceMember(us, name, function (scripts) {
        var args = Array.prototype.slice.call(arguments);
        if (Array.isArray(scripts)) args[0] = scripts.map(forRegistration);
        return orig.apply(us, args);
      });
    });
    var exec = us.execute;
    if (typeof exec === "function") {
      replaceMember(us, "execute", function (injection) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = withPrelude(injection);
        return exec.apply(us, args);
      });
    }
    // getScripts reports what was registered, without the prelude or the
    // resolved imports, to a callback too: Firefox would hand the callback its
    // own list.
    var get = us.getScripts;
    if (typeof get === "function") {
      replaceMember(us, "getScripts", function () {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.length && typeof args[args.length - 1] === "function" ? args.pop() : null;
        var p = get.apply(us, args);
        var strip = function (list) {
          return Array.isArray(list) ? list.map(function (s) {
            if (s && Array.isArray(s.js) && s.js.length && s.js[0] && s.js[0].code === userScriptWorldPrelude()) {
              var c = {}; for (var k in s) c[k] = s[k]; c.js = s.js.slice(1); s = c;
            }
            return mapScriptCode(s, registeredCodeImports);
          }) : list;
        };
        p = p && typeof p.then === "function" ? p.then(strip) : p;
        return cb ? respond(ns, Promise.resolve(p), cb) : p;
      });
    }
    PROMISE_ONLY.userScripts.forEach(function (name) { acceptCallback(ns, us, name); });
  }

  // ── runtime.onUserScriptMessage / onUserScriptConnect ──────────────────────
  // Chrome grants "userScripts" at install, so these events are there from the
  // background's first line; the user only switches chrome.userScripts on.
  // Firefox grants the permission only at runtime (about:addons, or
  // permissions.request) and defines the events then, so a background that adds
  // its listeners at startup misses them for the whole session, and its user
  // scripts can't message it. Until the grant, stand-ins keep the listeners, and
  // they move onto Firefox's events when it defines them. Only emitted for an
  // add-on whose Chrome manifest requires the permission.
  var USER_SCRIPT_EVENTS = ["onUserScriptMessage", "onUserScriptConnect"];

  function installUserScriptEvents() {
    if (!CONFIG.userScriptEvents || !isExtensionPage || !api.permissions || !api.runtime) return;
    namespaces.forEach(wrapUserScripts);
    var pending = [];
    namespaces.forEach(function (ns) {
      USER_SCRIPT_EVENTS.forEach(function (name) {
        var rt = ns.runtime;
        try { if (!rt || rt[name] != null) return; } catch (e) { return; }
        var listeners = [];
        var standIn = {
          addListener: function (fn) { if (listeners.indexOf(fn) < 0) listeners.push(fn); },
          removeListener: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
          hasListener: function (fn) { return listeners.indexOf(fn) >= 0; },
          hasListeners: function () { return listeners.length > 0; },
        };
        if (defineMissing(rt, name, standIn)) pending.push({ rt: rt, name: name, standIn: standIn, listeners: listeners });
      });
    });

    // Firefox replaces the stand-in with its own event when it grants the
    // permission, before permissions.onAdded fires.
    function adopt() {
      pending = pending.filter(function (p) {
        var real;
        try { real = p.rt[p.name]; } catch (e) { return true; }
        if (!real || real === p.standIn || typeof real.addListener !== "function") return true;
        p.listeners.forEach(function (fn) { try { real.addListener(fn); } catch (e) {} });
        dbg("userScripts: moved", p.listeners.length, "listener(s) onto runtime." + p.name);
        return false;
      });
      return pending.length === 0;
    }
    try {
      api.permissions.onAdded.addListener(function onAdded(perms) {
        if (!perms || !Array.isArray(perms.permissions) || perms.permissions.indexOf("userScripts") < 0) return;
        namespaces.forEach(wrapUserScripts);
        if (!adopt()) setTimeout(function () { namespaces.forEach(wrapUserScripts); adopt(); }, 0);
      });
    } catch (e) {}
  }

  // ── Messages Chrome would send as JSON ─────────────────────────────────────
  // Chrome serializes extension messages as JSON: a URL goes as its string, a
  // function is dropped. Firefox structured-clones them and fails on both:
  // runtime.sendMessage and tabs.sendMessage reject with a DataCloneError (or
  // call back with it as lastError), Port.postMessage throws it, and an answer
  // through sendResponse or a listener's promise fails silently, telling the
  // sender "Receiving end does not exist." What Firefox can clone keeps
  // Firefox's clone; what it can't is sent again as its JSON copy, the value
  // Chrome would have delivered. An answer is checked before it goes, since
  // Firefox reports nothing to retry on. Only emitted for a bundle that
  // messages.
  function isCloneError(e) {
    try { return !!e && (e.name === "DataCloneError" || /could not be cloned/i.test(String(e.message || e))); } catch (x) { return false; }
  }

  function jsonCopy(value) {
    if (value === undefined) return undefined;
    var s = JSON.stringify(value);
    return s === undefined ? undefined : JSON.parse(s);
  }

  // Arguments with the message (and the extension ID or options, which JSON
  // leaves as they are) as JSON; a callback stays.
  function jsonArgs(args) {
    return args.map(function (a) { return typeof a === "function" ? a : jsonCopy(a); });
  }

  // An answer as Chrome would deliver it.
  function sendable(value) {
    if (value === null || (typeof value !== "object" && typeof value !== "function") || typeof structuredClone !== "function") return value;
    try {
      structuredClone(value);
      return value;
    } catch (e) {
      if (!isCloneError(e)) return value;
      try { return jsonCopy(value); } catch (x) { return value; }
    }
  }

  function installMessageJsonFallback() {
    if (!CONFIG.messageJson) return;
    var patchedPorts = typeof WeakSet === "function" ? new WeakSet() : null;
    function patchPort(port) {
      if (!patchedPorts || !port || typeof port !== "object" || typeof port.postMessage !== "function" || patchedPorts.has(port)) return port;
      patchedPorts.add(port);
      var post = port.postMessage;
      replaceMember(port, "postMessage", function (message) {
        try {
          return post.apply(port, arguments);
        } catch (e) {
          if (!isCloneError(e)) throw e;
          var copy;
          try { copy = jsonCopy(message); } catch (x) { throw e; }
          return post.call(port, copy);
        }
      });
      return port;
    }

    function wrapSend(ns, obj, name) {
      var original = obj && obj[name];
      if (typeof original !== "function") return;
      replaceMember(obj, name, function () {
        var args = Array.prototype.slice.call(arguments);
        var last = args.length - 1;
        if (last >= 0 && typeof args[last] === "function") {
          var cb = args[last];
          args[last] = function () {
            var err = null;
            try { err = ns.runtime.lastError; } catch (e) {}
            if (err && isCloneError(err)) {
              var retry = null;
              try { retry = jsonArgs(args.slice(0, last)); } catch (e) {}
              if (retry) return original.apply(obj, retry.concat([cb]));
            }
            return cb.apply(this, arguments);
          };
          return original.apply(obj, args);
        }
        var retryAsJson = function (e) {
          if (!isCloneError(e)) throw e;
          var retry;
          try { retry = jsonArgs(args); } catch (x) { throw e; }
          return original.apply(obj, retry);
        };
        var result;
        try { result = original.apply(obj, args); } catch (e) { return retryAsJson(e); }
        return result && typeof result.then === "function" ? result.then(null, retryAsJson) : result;
      });
    }

    function wrapConnect(obj, name) {
      var original = obj && obj[name];
      if (typeof original !== "function") return;
      replaceMember(obj, name, function () { return patchPort(original.apply(obj, arguments)); });
    }

    // Listener wrappers, keyed by the add-on's function so removeListener and
    // hasListener work with the function it holds.
    function wrapListeners(ev, wrap) {
      if (!ev || typeof ev.addListener !== "function" || typeof WeakMap !== "function") return;
      var add = ev.addListener, remove = ev.removeListener, has = ev.hasListener;
      var wrappers = new WeakMap();
      function wrapperOf(fn) {
        var w = wrappers.get(fn);
        if (!w) { w = wrap(fn); wrappers.set(fn, w); }
        return w;
      }
      replaceMember(ev, "addListener", function (fn) {
        if (typeof fn !== "function") return add.apply(ev, arguments);
        var args = Array.prototype.slice.call(arguments);
        args[0] = wrapperOf(fn);
        return add.apply(ev, args);
      });
      if (typeof remove === "function") {
        replaceMember(ev, "removeListener", function (fn) {
          return remove.call(ev, (typeof fn === "function" && wrappers.get(fn)) || fn);
        });
      }
      if (typeof has === "function") {
        replaceMember(ev, "hasListener", function (fn) {
          return has.call(ev, (typeof fn === "function" && wrappers.get(fn)) || fn);
        });
      }
    }

    function answering(fn) {
      return function (message, sender, sendResponse) {
        var args = Array.prototype.slice.call(arguments);
        if (typeof sendResponse === "function") {
          args[2] = function (response) { return sendResponse.call(this, sendable(response)); };
        }
        var result = fn.apply(this, args);
        return result && typeof result === "object" && typeof result.then === "function" ? result.then(sendable) : result;
      };
    }

    function connecting(fn) {
      return function (port) {
        patchPort(port);
        return fn.apply(this, arguments);
      };
    }

    namespaces.forEach(function (ns) {
      var rt = null, tabs = null;
      try { rt = ns.runtime; } catch (e) {}
      try { tabs = ns.tabs; } catch (e) {}
      if (rt) {
        wrapSend(ns, rt, "sendMessage");
        wrapConnect(rt, "connect");
        ["onMessage", "onMessageExternal"].forEach(function (name) {
          var ev = null;
          try { ev = rt[name]; } catch (e) {}
          wrapListeners(ev, answering);
        });
        ["onConnect", "onConnectExternal"].forEach(function (name) {
          var ev = null;
          try { ev = rt[name]; } catch (e) {}
          wrapListeners(ev, connecting);
        });
      }
      if (tabs) {
        wrapSend(ns, tabs, "sendMessage");
        wrapConnect(tabs, "connect");
      }
    });
  }

  // ── Messages addressed to the add-on's own Chrome ID ────────────────────────
  // Chrome code that knows its ID passes it to runtime.sendMessage and
  // runtime.connect, and Chrome takes that as a message to itself (webext-redux
  // stores are built with `extensionId`). Firefox's add-on has its gecko ID, so
  // the message goes to an extension that doesn't exist: "Receiving end does
  // not exist", and the port disconnects. The Chrome ID becomes runtime.id for
  // the call. A lone string is a message, not an ID, as in Chrome. Only emitted
  // for a bundle that has its Chrome ID in its code.
  function installOwnChromeIdMessages() {
    if (!CONFIG.ownIdMessages || !CONFIG.extensionId) return;
    var chromeId = String(CONFIG.extensionId).toLowerCase();
    namespaces.forEach(function (ns) {
      var rt = null;
      try { rt = ns.runtime; } catch (e) {}
      if (!rt) return;
      [["sendMessage", 2], ["connect", 1]].forEach(function (pair) {
        var original = rt[pair[0]];
        if (typeof original !== "function") return;
        replaceMember(rt, pair[0], function () {
          var args = Array.prototype.slice.call(arguments);
          if (args.length >= pair[1] && typeof args[0] === "string" && args[0].toLowerCase() === chromeId) {
            try { args[0] = rt.id; } catch (e) {}
          }
          return original.apply(rt, args);
        });
      });
    });
  }

  // ── the "browser_action" menu context in MV3 ────────────────────────────────
  // Chrome's contextMenus takes "browser_action" from an MV3 extension and
  // keeps the item for its other contexts. Firefox's menus schema offers it to
  // MV2 only, so create() and update() throw a TypeError and the whole item is
  // lost, page and selection contexts included. MV3 calls the toolbar button's
  // menu "action"; code that still says browser_action means that menu, as a
  // user-agent sniff that takes a Firefox branch written for MV2 does. The
  // name is changed for the call, never in the add-on's object. Chrome itself
  // shows such an item on no toolbar menu in MV3, so Firefox shows one Chrome
  // doesn't when the code meant it for Chrome too. "page_action" is left as it
  // is: Firefox's MV3 still has page actions. Only emitted for a bundle that
  // names browser_action.
  function installMenuActionContext() {
    if (!CONFIG.menuActionContext) return;
    var version = 0;
    try { version = api.runtime.getManifest().manifest_version; } catch (e) {}
    if (version !== 3) return;
    function firefoxContexts(props) {
      if (!props || typeof props !== "object" || !Array.isArray(props.contexts) || props.contexts.indexOf("browser_action") < 0) return props;
      var contexts = [];
      props.contexts.forEach(function (c) {
        var name = c === "browser_action" ? "action" : c;
        if (contexts.indexOf(name) < 0) contexts.push(name);
      });
      return Object.assign({}, props, { contexts: contexts });
    }
    namespaces.forEach(function (ns) {
      ["menus", "contextMenus"].forEach(function (area) {
        var menus = null;
        try { menus = ns[area]; } catch (e) {}
        if (!menus || typeof menus !== "object") return;
        [["create", 0], ["update", 1]].forEach(function (m) {
          var native = menus[m[0]];
          if (typeof native !== "function") return;
          replaceMember(menus, m[0], function () {
            var args = Array.prototype.slice.call(arguments);
            args[m[1]] = firefoxContexts(args[m[1]]);
            return native.apply(menus, args);
          });
        });
      });
    });
  }

  // ── Content scripts injected at runtime ────────────────────────────────────
  // The conversion puts the shim first in every manifest content script, but
  // files injected later with scripting.executeScript, registered with
  // registerContentScripts or updateContentScripts, or run with
  // tabs.executeScript (MV2) ran without it in a tab no manifest script
  // matched: no window.chrome, no JSON fallback for messages, no favicon URLs.
  // The shim goes first in each such file list of the isolated world (the
  // page's own world has no extension API); where it already ran in that
  // frame, it returns at once. Injections of a function are left alone, and
  // getRegisteredContentScripts leaves the shim out. Only emitted for a
  // bundle that injects files.
  function withShimFirst(files) {
    var shim = CONFIG.injectShim;
    if (!Array.isArray(files) || !files.length) return files;
    var first = String(files[0]).replace(/^\/+/, "");
    return first === shim ? files : [shim].concat(files);
  }

  function withoutShim(files) {
    if (!Array.isArray(files) || !files.length || String(files[0]).replace(/^\/+/, "") !== CONFIG.injectShim) return files;
    return files.slice(1);
  }

  function installInjectedScriptShim() {
    if (typeof CONFIG.injectShim !== "string" || !CONFIG.injectShim || !isExtensionPage) return;
    function copyWith(obj, key, value) {
      var c = {};
      for (var k in obj) c[k] = obj[k];
      c[key] = value;
      return c;
    }
    function isolated(o) { return o && typeof o === "object" && o.world !== "MAIN"; }
    namespaces.forEach(function (ns) {
      var scripting = null, tabs = null;
      try { scripting = ns.scripting; } catch (e) {}
      try { tabs = ns.tabs; } catch (e) {}
      if (scripting && typeof scripting.executeScript === "function") {
        var exec = scripting.executeScript;
        replaceMember(scripting, "executeScript", function (details) {
          var args = Array.prototype.slice.call(arguments);
          if (isolated(details) && Array.isArray(details.files)) args[0] = copyWith(details, "files", withShimFirst(details.files));
          return exec.apply(scripting, args);
        });
      }
      ["registerContentScripts", "updateContentScripts"].forEach(function (name) {
        if (!scripting || typeof scripting[name] !== "function") return;
        var native = scripting[name];
        replaceMember(scripting, name, function (scripts) {
          var args = Array.prototype.slice.call(arguments);
          if (Array.isArray(scripts)) {
            args[0] = scripts.map(function (s) { return isolated(s) && Array.isArray(s.js) ? copyWith(s, "js", withShimFirst(s.js)) : s; });
          }
          return native.apply(scripting, args);
        });
      });
      if (scripting && typeof scripting.getRegisteredContentScripts === "function") {
        var getRegistered = scripting.getRegisteredContentScripts;
        replaceMember(scripting, "getRegisteredContentScripts", function () {
          var args = Array.prototype.slice.call(arguments);
          var cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
          var p = Promise.resolve(getRegistered.apply(scripting, args.length ? args : [])).then(function (list) {
            return Array.isArray(list) ? list.map(function (s) { return s && Array.isArray(s.js) ? copyWith(s, "js", withoutShim(s.js)) : s; }) : list;
          });
          return respond(ns, p, cb);
        });
      }
      // MV2: one file per call, so the shim goes in a call of its own first.
      if (tabs && typeof tabs.executeScript === "function") {
        var tabsExec = tabs.executeScript;
        replaceMember(tabs, "executeScript", function () {
          var args = Array.prototype.slice.call(arguments);
          var at = typeof args[0] === "object" && args[0] !== null ? 0 : 1;
          var details = args[at];
          if (!details || typeof details.file !== "string" || String(details.file).replace(/^\/+/, "") === CONFIG.injectShim) return tabsExec.apply(tabs, args);
          var shimDetails = { file: "/" + CONFIG.injectShim };
          ["allFrames", "frameId", "matchAboutBlank", "runAt"].forEach(function (k) { if (details[k] !== undefined) shimDetails[k] = details[k]; });
          var shimArgs = at === 1 ? [args[0], shimDetails] : [shimDetails];
          var first;
          try { first = Promise.resolve(api.tabs.executeScript.apply(api.tabs, shimArgs)); } catch (e) { first = Promise.reject(e); }
          var cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
          var p = first.catch(function (e) { dbg("shim injection failed:", errorMessage(e)); }).then(function () {
            return tabsExec.apply(tabs, args);
          });
          return respond(ns, p, cb);
        });
      }
    });
  }

  // ── chrome.declarativeContent ──────────────────────────────────────────────
  // Firefox has no declarativeContent. Add-ons that list the permission call it
  // without testing for it, usually inside onInstalled, so the rest of that
  // listener never ran (Tactiq's setup, Chrome extension source viewer's
  // action.disable()). The rules are kept here and applied by the background:
  //   - PageStateMatcher: pageUrl (Chrome's UrlFilter fields), css (selectors
  //     checked in the page once it has loaded, where the add-on may script
  //     it), isBookmarked (with the bookmarks API);
  //   - ShowAction / ShowPageAction: the tab's action is enabled while a rule
  //     matches, and back to the add-on's own setting for all tabs when none
  //     does; an MV2 page_action is shown and hidden instead;
  //   - SetIcon: the tab's icon while a rule matches;
  //   - RequestContentScript: its files are injected once per page load.
  // Chrome keeps rules across restarts, so they live in the background's
  // localStorage. A tab's URL is only visible with the tabs permission or
  // access to its site, so pageUrl conditions can't match other pages.
  // Emitted for an add-on whose Chrome manifest asks for declarativeContent
  // and whose code uses it.
  var DC_RULES_KEY = "__lavaductDeclarativeContent";

  function urlFilterMatches(f, href) {
    var u;
    try { u = new URL(href); } catch (e) { return false; }
    if (!f || typeof f !== "object") return true;
    var host = u.hostname, path = u.pathname, query = u.search.replace(/^\?/, "");
    var full = u.href.replace(/#.*$/, "");
    var originAndPath = u.origin + u.pathname;
    function has(k) { return typeof f[k] === "string"; }
    var lc = function (s) { return String(s).toLowerCase(); };
    if (has("hostContains") && lc(host).indexOf(lc(f.hostContains)) < 0 && lc("." + host).indexOf(lc(f.hostContains)) < 0) return false;
    if (has("hostEquals") && lc(host) !== lc(f.hostEquals)) return false;
    if (has("hostPrefix") && lc(host).indexOf(lc(f.hostPrefix)) !== 0) return false;
    if (has("hostSuffix") && !(lc(host).slice(-lc(f.hostSuffix).length) === lc(f.hostSuffix) || lc("." + host).slice(-lc(f.hostSuffix).length) === lc(f.hostSuffix))) return false;
    if (has("pathContains") && path.indexOf(f.pathContains) < 0) return false;
    if (has("pathEquals") && path !== f.pathEquals) return false;
    if (has("pathPrefix") && path.indexOf(f.pathPrefix) !== 0) return false;
    if (has("pathSuffix") && path.slice(-f.pathSuffix.length) !== f.pathSuffix) return false;
    if (has("queryContains") && query.indexOf(f.queryContains) < 0) return false;
    if (has("queryEquals") && query !== f.queryEquals) return false;
    if (has("queryPrefix") && query.indexOf(f.queryPrefix) !== 0) return false;
    if (has("querySuffix") && query.slice(-f.querySuffix.length) !== f.querySuffix) return false;
    if (has("urlContains") && full.indexOf(f.urlContains) < 0) return false;
    if (has("urlEquals") && full !== f.urlEquals) return false;
    if (has("urlPrefix") && full.indexOf(f.urlPrefix) !== 0) return false;
    if (has("urlSuffix") && full.slice(-f.urlSuffix.length) !== f.urlSuffix) return false;
    try {
      if (has("urlMatches") && !new RegExp(f.urlMatches).test(full)) return false;
      if (has("originAndPathMatches") && !new RegExp(f.originAndPathMatches).test(originAndPath)) return false;
    } catch (e) { return false; }
    if (Array.isArray(f.schemes) && f.schemes.indexOf(u.protocol.replace(/:$/, "")) < 0) return false;
    if (Array.isArray(f.ports)) {
      var port = Number(u.port || (u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : 0));
      var portOk = f.ports.some(function (p) { return Array.isArray(p) ? port >= p[0] && port <= p[1] : port === p; });
      if (!portOk) return false;
    }
    return true;
  }

  function installDeclarativeContent() {
    if (!CONFIG.declarativeContent || !isExtensionPage) return;
    function typed(type, fields) {
      var C = function (opts) {
        var o = opts && typeof opts === "object" ? opts : {};
        var self = this instanceof C ? this : Object.create(C.prototype);
        fields.forEach(function (k) { if (o[k] !== undefined) self[k] = o[k]; });
        Object.defineProperty(self, "instanceType", { value: "declarativeContent." + type, enumerable: true });
        return self;
      };
      return C;
    }
    var PageStateMatcher = typed("PageStateMatcher", ["pageUrl", "css", "isBookmarked"]);
    var ShowAction = typed("ShowAction", []);
    var ShowPageAction = typed("ShowPageAction", []);
    var SetIcon = typed("SetIcon", ["imageData", "path"]);
    var RequestContentScript = typed("RequestContentScript", ["js", "css", "allFrames", "matchAboutBlank"]);

    function stored() { var r = readLocal(DC_RULES_KEY); return Array.isArray(r) ? r : []; }
    function plainRule(rule, i) {
      return {
        id: typeof rule.id === "string" && rule.id ? rule.id : "_" + Date.now().toString(36) + "_" + i,
        priority: typeof rule.priority === "number" ? rule.priority : 100,
        tags: Array.isArray(rule.tags) ? rule.tags : undefined,
        conditions: (rule.conditions || []).map(function (c) { return JSON.parse(JSON.stringify(Object.assign({}, c, { instanceType: c.instanceType }))); }),
        actions: (rule.actions || []).map(function (a) { return JSON.parse(JSON.stringify(Object.assign({}, a, { instanceType: a.instanceType }))); }),
      };
    }
    function changed() {
      // The background applies the rules; other pages wake it to do so.
      if (isBackground) { if (applyAll) applyAll(); }
      else { try { Promise.resolve(api.runtime.getBackgroundPage()).then(function (bg) { if (bg && bg.__lavaductDeclarativeContentApply) bg.__lavaductDeclarativeContentApply(); }, noop); } catch (e) {} }
    }
    var onPageChanged = makeEvent().event;
    onPageChanged.addRules = function (rules, cb) {
      var p = Promise.resolve().then(function () {
        var list = Array.isArray(rules) ? rules.map(plainRule) : [];
        var ids = list.map(function (r) { return r.id; });
        var kept = stored().filter(function (r) { return ids.indexOf(r.id) < 0; });
        writeLocal(DC_RULES_KEY, kept.concat(list));
        changed();
        return list;
      });
      return respond(api, p, cb);
    };
    onPageChanged.removeRules = function (ids, cb) {
      if (typeof ids === "function") { cb = ids; ids = undefined; }
      var p = Promise.resolve().then(function () {
        writeLocal(DC_RULES_KEY, Array.isArray(ids) ? stored().filter(function (r) { return ids.indexOf(r.id) < 0; }) : []);
        changed();
      });
      return respond(api, p, cb);
    };
    onPageChanged.getRules = function (ids, cb) {
      if (typeof ids === "function") { cb = ids; ids = undefined; }
      var p = Promise.resolve().then(function () {
        var all = stored();
        return Array.isArray(ids) ? all.filter(function (r) { return ids.indexOf(r.id) >= 0; }) : all;
      });
      return respond(api, p, cb);
    };
    var dc = {
      PageStateMatcher: PageStateMatcher, ShowAction: ShowAction, ShowPageAction: ShowPageAction,
      SetIcon: SetIcon, RequestContentScript: RequestContentScript, onPageChanged: onPageChanged,
    };
    namespaces.forEach(function (ns) { defineMissing(ns, "declarativeContent", dc); });

    var applyAll = null;
    if (!isBackground || !api.tabs || !api.tabs.onUpdated) return;
    var action = api.action || api.browserAction || null;
    var pageAction = api.pageAction || null;
    var shown = {};     // tabId → whether a Show rule matched last time
    var iconSet = {};   // tabId → whether a SetIcon rule set its icon
    var injected = {};  // tabId → the URL its RequestContentScript files went into

    function cssMatches(tabId, selectors) {
      if (!api.scripting || typeof api.scripting.executeScript !== "function") return Promise.resolve(false);
      return Promise.resolve(api.scripting.executeScript({
        target: { tabId: tabId },
        func: function (sels) { try { return sels.every(function (s) { return !!document.querySelector(s); }); } catch (e) { return false; } },
        args: [selectors],
      })).then(function (r) { return !!(r && r[0] && r[0].result); }, function () { return false; });
    }
    function bookmarked(url) {
      var b = api.bookmarks;
      if (!b || typeof b.search !== "function") return Promise.resolve(false);
      return Promise.resolve(b.search({ url: url })).then(function (r) { return !!(r && r.length); }, function () { return false; });
    }
    function conditionMatches(c, tab) {
      if (!c || c.instanceType !== "declarativeContent.PageStateMatcher") return Promise.resolve(false);
      if (c.pageUrl && !(tab.url && urlFilterMatches(c.pageUrl, tab.url))) return Promise.resolve(false);
      var checks = [];
      if (Array.isArray(c.css) && c.css.length) checks.push(cssMatches(tab.id, c.css));
      if (typeof c.isBookmarked === "boolean") checks.push(tab.url ? bookmarked(tab.url).then(function (b) { return b === c.isBookmarked; }) : Promise.resolve(false));
      return Promise.all(checks).then(function (r) { return r.every(Boolean); });
    }
    function ruleMatches(rule, tab) {
      return Promise.all((rule.conditions || []).map(function (c) { return conditionMatches(c, tab); })).then(function (r) { return r.some(Boolean); });
    }
    function call(obj, name, arg) {
      try { if (obj && typeof obj[name] === "function") return Promise.resolve(obj[name](arg)).catch(noop); } catch (e) {}
      return Promise.resolve();
    }
    function applyTab(tab) {
      if (!tab || tab.id == null || tab.id < 0) return Promise.resolve();
      var rules = stored();
      return Promise.all(rules.map(function (r) { return ruleMatches(r, tab); })).then(function (hits) {
        var show = false, icon = null, scripts = [];
        rules.forEach(function (rule, i) {
          if (!hits[i]) return;
          (rule.actions || []).forEach(function (a) {
            var t = a && a.instanceType;
            if (t === "declarativeContent.ShowAction" || t === "declarativeContent.ShowPageAction") show = true;
            else if (t === "declarativeContent.SetIcon") icon = a;
            else if (t === "declarativeContent.RequestContentScript") scripts.push(a);
          });
        });
        var id = tab.id;
        var jobs = [];
        if (pageAction && !api.action) {
          if (show) jobs.push(call(pageAction, "show", id));
          else if (shown[id]) jobs.push(call(pageAction, "hide", id));
        } else if (action) {
          if (show) jobs.push(call(action, "enable", id));
          else if (shown[id]) {
            // Back to what the add-on set for all tabs.
            jobs.push(Promise.resolve(typeof action.isEnabled === "function" ? action.isEnabled({}) : true).then(function (on) {
              return call(action, on ? "enable" : "disable", id);
            }, noop));
          }
        }
        shown[id] = show;
        if (action && icon) { iconSet[id] = true; jobs.push(call(action, "setIcon", { tabId: id, imageData: icon.imageData, path: icon.path })); }
        else if (action && iconSet[id]) { delete iconSet[id]; jobs.push(call(action, "setIcon", { tabId: id, path: null })); }
        if (scripts.length && tab.url && injected[id] !== tab.url && api.scripting) {
          injected[id] = tab.url;
          scripts.forEach(function (s) {
            var target = { tabId: id, allFrames: s.allFrames === true };
            if (Array.isArray(s.css) && s.css.length) jobs.push(call(api.scripting, "insertCSS", { target: target, files: s.css }));
            if (Array.isArray(s.js) && s.js.length) jobs.push(call(api.scripting, "executeScript", { target: target, files: s.js }));
          });
        }
        return Promise.all(jobs);
      });
    }
    applyAll = function () {
      return Promise.resolve(api.tabs.query({})).then(function (tabs) { return Promise.all((tabs || []).map(applyTab)); }).catch(function (e) {
        dbg("declarativeContent:", errorMessage(e));
      });
    };
    try { Object.defineProperty(G, "__lavaductDeclarativeContentApply", { value: applyAll, configurable: true }); } catch (e) {}
    api.tabs.onUpdated.addListener(function (tabId, info, tab) {
      if (info.url && injected[tabId] !== info.url) delete injected[tabId];
      if (info.status === "complete" || info.url) applyTab(tab).catch(noop);
    });
    if (api.tabs.onRemoved) api.tabs.onRemoved.addListener(function (tabId) { delete shown[tabId]; delete iconSet[tabId]; delete injected[tabId]; });
    applyAll();
  }

  // ── externally_connectable ids ─────────────────────────────────────────────
  // In Chrome a manifest with externally_connectable lets in only the
  // extensions its `ids` lists: none when the list is missing, every one for
  // "*". Firefox has no such key and delivers every other add-on's messages
  // and ports to runtime.onMessageExternal and onConnectExternal. The add-on's
  // listeners now hear only the senders Chrome would let through. The list
  // holds Chrome IDs, so a sender converted by lavaduct matches by the Chrome
  // ID its add-on ID starts with. Only emitted for a manifest that declares
  // externally_connectable; the page bridge feeds web pages' messages to the
  // listeners directly, past this filter.
  function allowedSender(sender) {
    var ids = CONFIG.externalIds;
    if (ids.indexOf("*") >= 0) return true;
    var id = "";
    try { id = String((sender && sender.id) || ""); } catch (e) {}
    if (!id) return false;
    for (var i = 0; i < ids.length; i++) {
      var allowed = String(ids[i]);
      if (id === allowed) return true;
      if (id.indexOf(allowed.toLowerCase() + ".") === 0 && /@lavaduct$/.test(id)) return true;
    }
    return false;
  }

  function installExternalSenders() {
    if (!Array.isArray(CONFIG.externalIds) || typeof WeakMap !== "function") return;
    namespaces.forEach(function (ns) {
      var rt = null;
      try { rt = ns.runtime; } catch (e) {}
      if (!rt) return;
      [["onMessageExternal", 1], ["onConnectExternal", 0]].forEach(function (pair) {
        var ev = null;
        try { ev = rt[pair[0]]; } catch (e) {}
        if (!ev || typeof ev.addListener !== "function") return;
        var senderOf = pair[1] === 1 ? function (args) { return args[1]; } : function (args) { return args[0] && args[0].sender; };
        var add = ev.addListener, remove = ev.removeListener, has = ev.hasListener;
        var wrappers = new WeakMap();
        function wrapperOf(fn) {
          if (typeof fn !== "function") return fn;
          var w = wrappers.get(fn);
          if (!w) {
            w = function () {
              if (!allowedSender(senderOf(arguments))) {
                dbg(pair[0] + ": dropped a sender externally_connectable doesn't list:", senderOf(arguments) && senderOf(arguments).id);
                if (pair[1] === 0 && arguments[0] && typeof arguments[0].disconnect === "function") {
                  try { arguments[0].disconnect(); } catch (e) {}
                }
                return undefined;
              }
              return fn.apply(this, arguments);
            };
            wrappers.set(fn, w);
          }
          return w;
        }
        replaceMember(ev, "addListener", function (fn) {
          var args = Array.prototype.slice.call(arguments);
          args[0] = wrapperOf(fn);
          return add.apply(ev, args);
        });
        if (typeof remove === "function") replaceMember(ev, "removeListener", function (fn) { return remove.call(ev, wrappers.get(fn) || fn); });
        if (typeof has === "function") replaceMember(ev, "hasListener", function (fn) { return has.call(ev, wrappers.get(fn) || fn); });
      });
    });
  }

  // ── Values Chrome's storage keeps and Firefox can't clone ───────────────────
  // Chrome's storage.set serializes values: a function, or an object without
  // own data such as a URL, is stored as {}. Firefox structured-clones them and
  // refuses the whole call (in Firefox 160 for local, sync and session alike):
  // the promise rejects with "DataCloneError: Function object could not be
  // cloned.", the callback sees it as lastError, and nothing is stored. Rabby
  // keeps rules with a getValue function in storage.local. A call Firefox
  // takes stays Firefox's; one it refuses for a clone error is sent again with
  // what it couldn't clone replaced the way Chrome stores it. Only emitted for
  // a bundle that uses storage.
  function chromeStorable(value, ancestors) {
    if (typeof value === "function") return {};
    if (typeof value === "symbol") return undefined;
    if (value === null || typeof value !== "object") return value;
    if (ancestors.indexOf(value) >= 0) return undefined;
    var proto = Object.getPrototypeOf(value);
    var plain = Array.isArray(value) || proto === Object.prototype || proto === null;
    if (!plain && typeof structuredClone === "function") {
      try {
        structuredClone(value);
        return value;
      } catch (e) {
        if (!isCloneError(e)) return value;
      }
    }
    ancestors.push(value);
    var out;
    if (Array.isArray(value)) {
      out = [];
      for (var i = 0; i < value.length; i++) {
        var item = chromeStorable(value[i], ancestors);
        out.push(item === undefined ? null : item);
      }
    } else {
      out = {};
      Object.keys(value).forEach(function (k) {
        var v = chromeStorable(value[k], ancestors);
        if (v !== undefined) out[k] = v;
      });
    }
    ancestors.pop();
    return out;
  }

  // Chrome's storage.set also reads a value's properties the plain way, so a
  // getter's value is stored. Firefox 160 reads the items through Xrays, which
  // see only data properties: storage.local drops a value held in an accessor at
  // any depth, and every area drops a top-level key that is one. Ghostery's
  // options store (hybrids) keeps record entries as getters, so pausing a site
  // stored paused: {}. Items with an accessor in an object or array are copied
  // with the getters' values; anything else goes to Firefox as the same object.
  function withAccessorValues(value, ancestors) {
    if (value === null || typeof value !== "object") return value;
    var isArray = Array.isArray(value);
    if (!isArray && Object.prototype.toString.call(value) !== "[object Object]") return value;
    if (ancestors.indexOf(value) >= 0) return value;
    ancestors.push(value);
    var keys = Object.keys(value);
    var copy = null;
    for (var i = 0; i < keys.length; i++) {
      var desc = Object.getOwnPropertyDescriptor(value, keys[i]);
      if (!desc) continue;
      var accessor = !("value" in desc);
      var v = accessor ? value[keys[i]] : desc.value;
      var next = withAccessorValues(v, ancestors);
      if (copy === null && (accessor || next !== v)) {
        copy = isArray ? [] : {};
        for (var j = 0; j < i; j++) copy[keys[j]] = value[keys[j]];
      }
      if (copy !== null) copy[keys[i]] = next;
    }
    ancestors.pop();
    return copy === null ? value : copy;
  }

  function installStorageCloneFallback() {
    if (!CONFIG.storageClone) return;
    namespaces.forEach(function (ns) {
      var storage = null;
      try { storage = ns.storage; } catch (e) {}
      if (!storage) return;
      ["local", "sync", "session"].forEach(function (name) {
        var area = null;
        try { area = storage[name]; } catch (e) {}
        var set = area && area.set;
        if (typeof set !== "function") return;
        replaceMember(area, "set", function (items) {
          var args = Array.prototype.slice.call(arguments);
          var resolved = items;
          try { resolved = withAccessorValues(items, []); } catch (e) {}
          if (resolved !== items) { items = resolved; args[0] = resolved; }
          var storable = function () { return chromeStorable(items, []); };
          var last = args.length - 1;
          if (last >= 1 && typeof args[last] === "function") {
            var cb = args[last];
            args[last] = function () {
              var err = null;
              try { err = ns.runtime.lastError; } catch (e) {}
              if (err && isCloneError(err)) {
                var copy = null;
                try { copy = storable(); } catch (e) {}
                if (copy) return set.call(area, copy, cb);
              }
              return cb.apply(this, arguments);
            };
            return set.apply(area, args);
          }
          var retry = function (e) {
            if (!isCloneError(e)) throw e;
            var copy;
            try { copy = storable(); } catch (x) { throw e; }
            return set.call(area, copy);
          };
          var result;
          try { result = set.apply(area, args); } catch (e) { return retry(e); }
          return result && typeof result.then === "function" ? result.then(null, retry) : result;
        });
      });
    });
  }

  // ── chrome.proxy.settings ──────────────────────────────────────────────────
  // Chrome takes the proxy as proxy.settings.set({ value: { mode, rules,
  // pacScript } }). Firefox's proxy.settings wants another shape (proxyType,
  // http, ssl, autoConfigUrl) and refuses every change unless the user lets the
  // add-on run in private windows ("proxy.settings requires private browsing
  // permission."), so a Chrome VPN's connect fails. proxy.onRequest needs no
  // such grant, and the emulation routes requests with it:
  //   - direct, fixed_servers (singleProxy, proxyForHttp/Https/Ftp,
  //     fallbackProxy, bypassList with Chrome's rule syntax, <local>, CIDR and
  //     the implicit loopback bypass) and pac_script (data or url) are applied
  //     by a listener in the background;
  //   - a PAC script is code, so it runs in a manifest sandbox page the
  //     background frames (the add-on's CSP forbids eval in its own pages), and
  //     its synchronous DNS calls are answered from lookups the background makes
  //     between rounds (dns.resolve when the add-on may use it, otherwise as a
  //     failed lookup). A script that fails sends requests direct, or, with
  //     pacScript.mandatory, to a proxy that can't exist, as Chrome refuses them;
  //   - system leaves requests to Firefox's own settings; auto_detect has no
  //     onRequest form and goes to Firefox's settings, which need the grant.
  // The config lives in the add-on's localStorage, shared by all its pages, so
  // the background reads it synchronously when Firefox wakes it and registers
  // its listener before any request waits on it. get() reports it with Chrome's
  // levelOfControl, clear() drops it, onChange fires in every page. A value in
  // Firefox's own shape (no mode) goes to Firefox's proxy.settings as before.
  // Only emitted for a bundle that names proxy.settings.
  var PROXY_STATE_KEY = "__lavaductProxySettings";
  var PROXY_REFRESH = "__lavaductProxyRefresh";
  var PROXY_MODES = ["direct", "auto_detect", "pac_script", "fixed_servers", "system"];
  var PROXY_SCOPES = ["regular", "regular_only", "incognito_persistent", "incognito_session_only"];
  var PROXY_PORTS = { http: 80, https: 443, socks4: 1080, socks5: 1080 };

  function isIpv4(s) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    return !!m && m.slice(1).every(function (p) { return Number(p) <= 255; });
  }

  // An IP literal as eight 16-bit words (IPv4 as ::ffff:a.b.c.d), or null.
  function ipWords(s) {
    s = String(s).replace(/^\[|\]$/g, "");
    if (isIpv4(s)) s = "::ffff:" + s;
    if (!/^[0-9a-f:.]+$/i.test(s) || s.indexOf(":") < 0) return null;
    var tail4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    var extra = [];
    if (tail4) {
      if (!isIpv4(tail4[2])) return null;
      var p = tail4[2].split(".").map(Number);
      extra = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
      s = tail4[1].replace(/:$/, "") || ":";
      if (s === ":") s = "::";
    }
    var halves = s.split("::");
    if (halves.length > 2) return null;
    var head = halves[0] ? halves[0].split(":") : [];
    var tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    var fill = 8 - extra.length - head.length - tail.length;
    if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
    var words = head.concat(new Array(halves.length === 2 ? fill : 0).fill("0"), tail);
    for (var i = 0; i < words.length; i++) {
      if (!/^[0-9a-f]{1,4}$/i.test(words[i])) return null;
      words[i] = parseInt(words[i], 16);
    }
    return words.concat(extra);
  }

  function inCidr(words, cidr) {
    var bits = cidr.bits;
    for (var i = 0; i < 8 && bits > 0; i++, bits -= 16) {
      var m = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
      if ((words[i] & m) !== (cidr.words[i] & m)) return false;
    }
    return true;
  }

  function globRegExp(pattern) {
    return new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
  }

  // Chrome's ProxyBypassRules: [scheme://]host-pattern[:port], ".suffix",
  // IP literals, a.b.c.d/n and [v6]/n, <local> (names without a dot), and
  // <-loopback>, which turns off the implicit localhost/127.0.0.0/8/[::1] bypass.
  function parseBypass(list) {
    var rules = [], loopback = true;
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      var r = String(raw).trim().toLowerCase();
      if (!r) return;
      if (r === "<local>") { rules.push({ local: true }); return; }
      if (r === "<-loopback>") { loopback = false; return; }
      var slash = /^\[?([0-9a-f:.]+)\]?\/(\d{1,3})$/.exec(r);
      if (slash && ipWords(slash[1])) {
        rules.push({ cidr: { words: ipWords(slash[1]), bits: Number(slash[2]) + (isIpv4(slash[1]) ? 96 : 0) } });
        return;
      }
      var scheme = null, port = null;
      var sm = /^([a-z][a-z0-9+.-]*):\/\//.exec(r);
      if (sm) { scheme = sm[1]; r = r.slice(sm[0].length); }
      var pm = /^(\[[^\]]*\]|[^:]*):(\d+)$/.exec(r);
      if (pm) { r = pm[1]; port = Number(pm[2]); }
      var ip = ipWords(r);
      if (ip) { rules.push({ scheme: scheme, port: port, ip: ip }); return; }
      if (r.charAt(0) === ".") r = "*" + r;
      rules.push({ scheme: scheme, port: port, host: globRegExp(r) });
    });
    return { rules: rules, loopback: loopback };
  }

  var LOOPBACK = parseBypass(["localhost", "*.localhost", "127.0.0.1/8", "[::1]"]).rules;

  function bypassed(bypass, u) {
    var host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    var ip = ipWords(host);
    var scheme = u.protocol.replace(/:$/, "");
    var port = u.port ? Number(u.port) : ({ http: 80, ws: 80, https: 443, wss: 443, ftp: 21 })[scheme];
    var rules = bypass.loopback ? LOOPBACK.concat(bypass.rules) : bypass.rules;
    return rules.some(function (r) {
      if (r.local) return !ip && host.indexOf(".") < 0;
      if (r.cidr) return !!ip && inCidr(ip, r.cidr);
      if (r.scheme && r.scheme !== scheme) return false;
      if (r.port && r.port !== port) return false;
      if (r.ip) return !!ip && r.ip.join() === ip.join();
      return r.host.test(host);
    });
  }

  function firefoxProxy(server) {
    var scheme = server.scheme || "http";
    var info = { type: scheme === "socks5" ? "socks" : scheme, host: String(server.host).replace(/^\[|\]$/g, ""), port: Number(server.port) || PROXY_PORTS[scheme] };
    if (scheme === "socks5") info.proxyDNS = true;
    return info;
  }

  function fixedServers(rules, u) {
    if (bypassed(parseBypass(rules.bypassList), u)) return { type: "direct" };
    var scheme = u.protocol.replace(/:$/, "");
    var server = rules.singleProxy ||
      (scheme === "http" || scheme === "ws" ? rules.proxyForHttp : scheme === "https" || scheme === "wss" ? rules.proxyForHttps : scheme === "ftp" ? rules.proxyForFtp : null) ||
      rules.fallbackProxy;
    return server ? firefoxProxy(server) : { type: "direct" };
  }

  // "PROXY a:1; SOCKS5 b:2; DIRECT" as Firefox's failover list.
  function pacProxies(text) {
    var out = [];
    String(text).split(";").forEach(function (entry) {
      var e = entry.trim();
      if (/^direct$/i.test(e)) { out.push({ type: "direct" }); return; }
      var m = /^(proxy|http|https|socks|socks4|socks5)\s+(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/i.exec(e);
      if (!m) return;
      var kind = m[1].toLowerCase();
      var scheme = kind === "https" ? "https" : kind === "socks5" ? "socks5" : kind === "socks" || kind === "socks4" ? "socks4" : "http";
      out.push(firefoxProxy({ scheme: scheme, host: m[2], port: m[3] }));
    });
    return out.length ? out : [{ type: "direct" }];
  }

  function validateProxyValue(v) {
    if (PROXY_MODES.indexOf(v.mode) < 0) throw new Error("Invalid value for proxy config mode: " + v.mode + "; expected one of " + PROXY_MODES.join(", ") + ".");
    if (v.mode === "fixed_servers") {
      var r = v.rules;
      if (!r || typeof r !== "object") throw new Error("fixed_servers requires rules.");
      ["singleProxy", "proxyForHttp", "proxyForHttps", "proxyForFtp", "fallbackProxy"].forEach(function (k) {
        var s = r[k];
        if (s == null) return;
        if (typeof s !== "object" || typeof s.host !== "string" || !s.host) throw new Error("rules." + k + " needs a host.");
        var scheme = s.scheme || "http";
        if (scheme === "quic") throw new Error("rules." + k + ": QUIC proxies have no Firefox equivalent.");
        if (!PROXY_PORTS[scheme]) throw new Error("rules." + k + ": unknown proxy scheme " + scheme + ".");
      });
    }
    if (v.mode === "pac_script") {
      var p = v.pacScript;
      if (!p || (typeof p.data !== "string" && typeof p.url !== "string")) throw new Error("pac_script requires pacScript.url or pacScript.data.");
    }
  }

  // A value in Firefox's shape, in Chrome's: mode added, Firefox's members kept
  // for code written against either.
  function chromeProxyValue(v) {
    var out = {};
    if (v && typeof v === "object") Object.keys(v).forEach(function (k) { out[k] = v[k]; });
    var t = out.proxyType;
    var server = function (s, scheme) {
      var m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(s || ""));
      return m ? { scheme: scheme, host: m[1], port: m[2] ? Number(m[2]) : PROXY_PORTS[scheme] } : null;
    };
    if (t === "none") out.mode = "direct";
    else if (t === "autoDetect") out.mode = "auto_detect";
    else if (t === "autoConfig") { out.mode = "pac_script"; out.pacScript = { url: out.autoConfigUrl || "", mandatory: false }; }
    else if (t === "manual") {
      out.mode = "fixed_servers";
      var rules = {};
      if (out.http && out.httpProxyAll) rules.singleProxy = server(out.http, "http");
      else {
        if (out.http) rules.proxyForHttp = server(out.http, "http");
        if (out.ssl) rules.proxyForHttps = server(out.ssl, "http");
        if (out.socks) rules.fallbackProxy = server(out.socks, out.socksVersion === 4 ? "socks4" : "socks5");
      }
      if (out.passthrough) rules.bypassList = String(out.passthrough).split(/[,\s]+/).filter(Boolean);
      out.rules = rules;
    } else out.mode = "system";
    return out;
  }

  function proxyEffective(state, incognito) {
    return incognito ? state.incognito || (state.regularOnly ? null : state.regular) || null : state.regular || null;
  }

  // Whether the background must route requests itself.
  function proxyRouting(state) {
    return [state.regular, state.incognito].some(function (v) {
      return !!v && (v.mode === "direct" || v.mode === "fixed_servers" || v.mode === "pac_script");
    });
  }

  function readProxyState() {
    var s = readLocal(PROXY_STATE_KEY);
    return s && typeof s === "object" ? s : {};
  }

  function installProxySettings() {
    if (!CONFIG.proxySettings || !isExtensionPage) return;
    var nativeProxy = null, nativeSettings = null;
    try { nativeProxy = api.proxy; nativeSettings = nativeProxy && nativeProxy.settings; } catch (e) {}
    if (!nativeSettings || !localStore) return;
    var state = readProxyState();
    var changed = makeEvent();
    var listening = false;
    var pacTexts = {};

    function nativeCall(name, details) {
      try { return Promise.resolve(nativeSettings[name](details || {})); } catch (e) { return Promise.reject(e); }
    }

    function levelFromFirefox(level) {
      return level === "controlled_by_other_extensions" ? level : level === "controlled_by_this_extension" ? level : "controllable_by_this_extension";
    }

    function getDetails(details) {
      var incognito = !!(details && details.incognito);
      var v = proxyEffective(state, incognito);
      if (v && v.mode !== "auto_detect") {
        var own = { value: JSON.parse(JSON.stringify(v)), levelOfControl: "controlled_by_this_extension" };
        if (incognito) own.incognitoSpecific = !!state.incognito;
        return Promise.resolve(own);
      }
      return nativeCall("get", {}).then(function (n) {
        var out = { value: v ? { mode: "auto_detect" } : chromeProxyValue(n && n.value), levelOfControl: v ? "controlled_by_this_extension" : levelFromFirefox(n && n.levelOfControl) };
        if (incognito) out.incognitoSpecific = !!state.incognito;
        return out;
      }, function () {
        return { value: { mode: v ? "auto_detect" : "system" }, levelOfControl: v ? "controlled_by_this_extension" : "controllable_by_this_extension" };
      });
    }

    function announce() {
      getDetails({}).then(function (d) { changed.dispatch(d); }, noop);
    }

    function save(next) {
      state = next;
      try {
        if (state.regular || state.incognito) localStore.setItem(PROXY_STATE_KEY, JSON.stringify(state));
        else localStore.removeItem(PROXY_STATE_KEY);
      } catch (e) {}
      announce();
      if (isBackground) { route(); return Promise.resolve(); }
      // Chrome's set() resolves once the setting is in force, so the call waits
      // for the background (woken if suspended) to route with the new config;
      // its storage event can come later than the page's next request.
      var bg;
      try { bg = api.runtime.getBackgroundPage(); } catch (e) { return Promise.resolve(); }
      return Promise.resolve(bg).then(function (w) {
        try { if (w && typeof w[PROXY_REFRESH] === "function") w[PROXY_REFRESH](); } catch (e) {}
      }, noop);
    }

    function setDetails(details) {
      details = details || {};
      var value = details.value;
      if (!value || typeof value !== "object" || value.mode === undefined) return nativeCall("set", details);
      try { validateProxyValue(value); } catch (e) { return Promise.reject(e); }
      var scope = details.scope || "regular";
      if (PROXY_SCOPES.indexOf(scope) < 0) return Promise.reject(new Error("Invalid scope: " + scope + "."));
      var copy = JSON.parse(JSON.stringify(value));
      var apply = function () {
        var next = JSON.parse(JSON.stringify(state));
        if (scope === "regular" || scope === "regular_only") { next.regular = copy; next.regularOnly = scope === "regular_only"; }
        else next.incognito = copy;
        return save(next);
      };
      if (copy.mode === "pac_script") {
        return pacCompiles().then(function (ok) {
          if (!ok) throw new Error("proxy mode pac_script can't work in this Firefox: the PAC script runs in a manifest sandbox page, which Firefox supports from Firefox 154 on; older releases load it as an ordinary extension page, where code can't be compiled.");
          return apply();
        });
      }
      if (copy.mode !== "auto_detect") return apply();
      return nativeCall("set", { value: { proxyType: "autoDetect" } }).then(apply, function (e) {
        throw new Error("proxy mode auto_detect needs Firefox's own proxy settings, which Firefox lets an add-on change only when it may run in private windows (" + errorMessage(e) + ")");
      });
    }

    // Whether the sandbox page may compile code. Firefox before 154 has no
    // manifest sandbox pages and loads it as an ordinary page, whose CSP
    // refuses Function(); a pac_script config would then send everything
    // direct without a word, so set() is refused instead. Checked once per page.
    var pacCheck = null;
    function pacCompiles() {
      var canFrame = false;
      try { canFrame = typeof document !== "undefined" && !!document && typeof document.createElement === "function"; } catch (e) {}
      if (!canFrame) return Promise.resolve(true);
      if (!pacCheck) {
        pacCheck = pacEval({ script: "function FindProxyForURL() { return 'DIRECT'; }", url: "http://pac-check.invalid/", host: "pac-check.invalid", dns: {} })
          .then(function (r) { return !(r && r.compileBlocked); }, function () { return false; });
      }
      return pacCheck;
    }

    function clearDetails(details) {
      var scope = (details && details.scope) || "regular";
      var next = JSON.parse(JSON.stringify(state));
      var cleared = scope === "regular" || scope === "regular_only" ? next.regular : next.incognito;
      if (scope === "regular" || scope === "regular_only") { delete next.regular; delete next.regularOnly; }
      else delete next.incognito;
      var saved = cleared ? save(next) : Promise.resolve();
      if (!cleared || cleared.mode === "auto_detect") return saved.then(function () { return nativeCall("clear", {}); }).then(noop, noop);
      return saved;
    }

    // ── the background's router ──
    var pacFrame = null, pacLoaded = null, pacWaiting = {}, pacSeq = 0;

    function pacEval(message) {
      if (!pacFrame) {
        pacFrame = document.createElement("iframe");
        try { pacFrame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;"; } catch (e) {}
        pacLoaded = new Promise(function (resolve) { pacFrame.addEventListener("load", resolve); });
        pacFrame.src = extensionUrl(CONFIG.pacPage);
        (document.body || document.documentElement).appendChild(pacFrame);
        G.addEventListener("message", function (e) {
          var d = e.data;
          if (!pacFrame || e.source !== pacFrame.contentWindow || !d || d.__lavaductPac !== true) return;
          var w = pacWaiting[d.id];
          if (w) { delete pacWaiting[d.id]; w(d); }
        });
      }
      return pacLoaded.then(function () {
        return new Promise(function (resolve, reject) {
          var id = ++pacSeq;
          var timer = setTimeout(function () { delete pacWaiting[id]; reject(new Error("the PAC script didn't answer within 10 s")); }, 10000);
          pacWaiting[id] = function (d) { clearTimeout(timer); resolve(d); };
          message.__lavaductPac = true;
          message.id = id;
          pacFrame.contentWindow.postMessage(message, "*");
        });
      });
    }

    function resolveName(name) {
      try {
        if (api.dns && typeof api.dns.resolve === "function") {
          return api.dns.resolve(name).then(function (r) { return (r && r.addresses) || []; }, function () { return []; });
        }
      } catch (e) {}
      return Promise.resolve([]);
    }

    function pacText(p) {
      if (typeof p.data === "string") return Promise.resolve(p.data);
      var cached = pacTexts[p.url];
      if (!cached) {
        cached = pacTexts[p.url] = (nativeFetch ? nativeFetch(p.url, { cache: "no-store" }) : Promise.reject(new Error("no fetch"))).then(function (r) {
          if (!r.ok) throw new Error("PAC file " + p.url + " answered " + r.status);
          return r.text();
        });
        cached.catch(function () { if (pacTexts[p.url] === cached) delete pacTexts[p.url]; });
      }
      return cached;
    }

    function routePac(p, u) {
      // The PAC file's own download goes direct.
      if (typeof p.data !== "string" && u.href === p.url) return { type: "direct" };
      var url = u.href;
      // Chrome hands PAC scripts only the origin of secure URLs.
      if (u.protocol === "https:" || u.protocol === "wss:") url = u.protocol + "//" + u.host + "/";
      var host = u.hostname.replace(/^\[|\]$/g, "");
      var dns = {};
      function round(n) {
        return pacText(p).then(function (script) {
          return pacEval({ script: script, url: url, host: host, dns: dns });
        }).then(function (r) {
          if (r.error) throw new Error(r.error);
          if (r.needDns == null) return pacProxies(r.result);
          if (n >= 16) throw new Error("the PAC script asked for more than 16 DNS lookups");
          return resolveName(r.needDns).then(function (ips) { dns[r.needDns] = ips; return round(n + 1); });
        });
      }
      return round(0).then(null, function (e) {
        dbg("PAC script failed for", url + ":", errorMessage(e));
        return p.mandatory ? [{ type: "http", host: "pac-script-failed.invalid", port: 1 }] : { type: "direct" };
      });
    }

    function onRequest(info) {
      var v = proxyEffective(state, !!info.incognito);
      if (!v) return undefined;
      var u;
      try { u = new URL(info.url); } catch (e) { return undefined; }
      if (v.mode === "direct") return { type: "direct" };
      if (v.mode === "fixed_servers") return fixedServers(v.rules || {}, u);
      if (v.mode === "pac_script") return routePac(v.pacScript || {}, u);
      return undefined;
    }

    function route() {
      var want = proxyRouting(state);
      if (want === listening) return;
      try {
        if (want) nativeProxy.onRequest.addListener(onRequest, { urls: ["<all_urls>"] });
        else nativeProxy.onRequest.removeListener(onRequest);
        listening = want;
      } catch (e) { dbg("proxy.onRequest failed:", errorMessage(e)); }
    }

    if (isBackground && nativeProxy.onRequest) route();
    // The pages' set() and clear() call this on the background's window.
    if (isBackground) {
      try {
        Object.defineProperty(G, PROXY_REFRESH, { value: function () { state = readProxyState(); route(); }, configurable: true });
      } catch (e) {}
    }
    // Another page of the add-on changed the config.
    try {
      G.addEventListener("storage", function (e) {
        if (e.key !== PROXY_STATE_KEY && e.key !== null) return;
        state = readProxyState();
        if (isBackground) route();
        announce();
      });
    } catch (e) {}

    namespaces.forEach(function (ns) {
      var p = null;
      try { p = ns.proxy; } catch (e) {}
      if (!p || typeof p !== "object") return;
      replaceMember(p, "settings", {
        get: function (details, cb) { return respond(ns, getDetails(details), cb); },
        set: function (details, cb) { return respond(ns, setDetails(details), cb); },
        clear: function (details, cb) { return respond(ns, clearDetails(details), cb); },
        onChange: changed.event,
      });
    });
  }

  // ── "extraHeaders" in webRequest listeners ──────────────────────────────────
  // Chrome needs "extraHeaders" in a listener's extraInfoSpec to show headers
  // such as Cookie or Referer; Firefox shows every header without it, has no
  // such value, and refuses the whole listener ("Invalid enumeration value").
  // Each webRequest event's addListener drops it from the spec; the add-on's
  // function is passed through as it is, so removeListener and hasListener
  // still find it. A spec left empty, or passed as undefined, isn't passed on:
  // Chrome takes one on every event, but Firefox's onErrorOccurred has no such
  // parameter and refuses any third argument ("Incorrect argument types").
  // Only emitted for a bundle that names extraHeaders.
  function installWebRequestExtraHeaders() {
    if (!CONFIG.extraHeaders) return;
    namespaces.forEach(function (ns) {
      var wr = null;
      try { wr = ns.webRequest; } catch (e) {}
      if (!wr || typeof wr !== "object") return;
      Object.keys(wr).forEach(function (name) {
        if (!/^on[A-Z]/.test(name)) return;
        var ev = null;
        try { ev = wr[name]; } catch (e) {}
        if (!ev || typeof ev.addListener !== "function") return;
        var add = ev.addListener;
        replaceMember(ev, "addListener", function (fn, filter, spec) {
          var args = Array.prototype.slice.call(arguments);
          if (args.length > 2) {
            var kept = Array.isArray(spec) ? spec.filter(function (v) { return v !== "extraHeaders"; }) : spec;
            if (kept == null || (Array.isArray(kept) && !kept.length)) args.length = 2;
            else if (kept !== spec && kept.length !== spec.length) args[2] = kept;
          }
          return add.apply(ev, args);
        });
      });
    });
  }

  // ── A listener's filter passed as false ────────────────────────────────────
  // Code built for both browsers passes an event's filter as
  // `isFirefox && { … }`, which a Chrome build compiles to
  // addListener(fn, false). Firefox's schemas refuse false, 0 or "" where a
  // filter object or nothing goes ("Incorrect argument types for
  // tabs.onUpdated"), and the throw ends the script that registered it. A
  // trailing argument that is falsy (false, 0, "", null, undefined) is left
  // out instead: that's what the add-on means by it. The function is passed on
  // as it is, so removeListener and hasListener still find it. Every event
  // object the namespaces hold is wrapped once (chrome and browser share them);
  // a namespace a later permission grant adds isn't. Only emitted for a bundle
  // that passes addListener a last argument that may be false.
  function installFalsyListenerArgs() {
    if (!CONFIG.falsyListenerArgs) return;
    var wrapped = [];
    function wrapEvent(ev) {
      if (wrapped.indexOf(ev) >= 0) return;
      wrapped.push(ev);
      var add = ev.addListener;
      replaceMember(ev, "addListener", function () {
        var args = Array.prototype.slice.call(arguments);
        while (args.length > 1 && !args[args.length - 1]) args.length--;
        return add.apply(ev, args);
      });
    }
    function walk(obj, depth) {
      var keys;
      try { keys = Object.keys(obj); } catch (e) { return; }
      keys.forEach(function (key) {
        var v = null;
        try { v = obj[key]; } catch (e) {}
        if (!v || typeof v !== "object") return;
        if (/^on[A-Z]/.test(key)) {
          if (typeof v.addListener === "function") wrapEvent(v);
        } else if (depth > 0) {
          walk(v, depth - 1);
        }
      });
    }
    namespaces.forEach(function (ns) { walk(ns, 2); });
  }

  // ── permissions Firefox doesn't know ───────────────────────────────────────
  // The conversion removes the permissions Firefox doesn't know, offscreen and
  // sidePanel among them, and Firefox's permissions.contains, request and
  // remove throw synchronously on such a name. Chrome answers, and code checks
  // contains({ permissions: ["offscreen"] }) before it creates its document.
  // CONFIG.permissionAnswers names each of them: true when the Chrome manifest
  // asked for it and the shim emulates the API, so the add-on has it; false
  // otherwise. Those names are answered here, the rest go to Firefox, and a
  // call naming none of them goes to Firefox untouched. Only emitted for a
  // bundle that calls permissions.*.
  function installPermissions() {
    var answers = CONFIG.permissionAnswers;
    if (!answers || typeof answers !== "object") return;
    var nativePerms = null;
    try { nativePerms = api.permissions; } catch (e) {}
    if (!nativePerms) return;
    var granted = Object.keys(answers).filter(function (n) { return answers[n] === true; });

    // { ok: every name answered here is granted, rest: the filter for Firefox,
    // or null when nothing is left for it }; null when the filter names none.
    function split(perms) {
      var names = perms && typeof perms === "object" && Array.isArray(perms.permissions) ? perms.permissions : [];
      var own = names.filter(function (n) { return Object.prototype.hasOwnProperty.call(answers, n); });
      if (!own.length) return null;
      var left = names.filter(function (n) { return own.indexOf(n) < 0; });
      var rest = Object.assign({}, perms, { permissions: left });
      var forFirefox = left.length > 0 || Object.keys(rest).some(function (k) {
        return k !== "permissions" && Array.isArray(rest[k]) && rest[k].length > 0;
      });
      return {
        ok: own.every(function (n) { return answers[n] === true; }),
        rest: forFirefox ? rest : null,
      };
    }

    namespaces.forEach(function (ns) {
      var perms = null;
      try { perms = ns.permissions; } catch (e) {}
      if (!perms) return;
      function wrap(name, answer) {
        var original = perms[name];
        var native = nativePerms[name];
        if (typeof original !== "function" || typeof native !== "function") return;
        replaceMember(perms, name, function (filter, cb) {
          var parts = split(filter);
          if (!parts) return original.apply(perms, arguments);
          var p;
          try { p = Promise.resolve(answer(parts, function (f) { return native.call(nativePerms, f); })); } catch (e) { p = Promise.reject(e); }
          return respond(ns, p, cb);
        });
      }
      wrap("contains", function (parts, firefox) {
        if (!parts.ok) return false;
        return parts.rest ? firefox(parts.rest) : true;
      });
      // Forwarded before anything is awaited: Firefox only prompts inside the
      // user action. A request that can't be granted in full prompts for nothing.
      wrap("request", function (parts, firefox) {
        if (!parts.ok) return false;
        return parts.rest ? firefox(parts.rest) : true;
      });
      // An emulated permission can't be taken away, and a removed one was never there.
      wrap("remove", function (parts, firefox) {
        return parts.rest ? Promise.resolve(firefox(parts.rest)).then(function () { return false; }) : false;
      });
      var getAll = perms.getAll;
      var nativeGetAll = nativePerms.getAll;
      if (granted.length && typeof getAll === "function" && typeof nativeGetAll === "function") {
        replaceMember(perms, "getAll", function (cb) {
          var p = Promise.resolve().then(function () { return nativeGetAll.call(nativePerms); }).then(function (all) {
            var out = Object.assign({}, all);
            var list = Array.isArray(out.permissions) ? out.permissions.slice() : [];
            granted.forEach(function (n) { if (list.indexOf(n) < 0) list.push(n); });
            out.permissions = list;
            return out;
          });
          return respond(ns, p, cb);
        });
      }
    });
  }

  // ── storage.managed without a policy ───────────────────────────────────────
  // With no enterprise policy for the add-on, Chrome answers storage.managed.get()
  // as an empty area does: {}, or the defaults it was given. Firefox rejects it
  // ("Managed storage manifest not found"), and code reading an optional managed
  // setting then takes its error path, or retries.
  function installManagedStorage() {
    var nativeManaged = null;
    try { nativeManaged = api.storage && api.storage.managed; } catch (e) {}
    if (!nativeManaged || typeof nativeManaged.get !== "function") return;
    var nativeGet = nativeManaged.get;
    namespaces.forEach(function (ns) {
      var managed = null;
      try { managed = ns.storage && ns.storage.managed; } catch (e) {}
      if (!managed || typeof managed.get !== "function") return;
      replaceMember(managed, "get", function (keys, cb) {
        if (typeof keys === "function") { cb = keys; keys = undefined; }
        var p = Promise.resolve()
          .then(function () { return keys == null ? nativeGet.call(nativeManaged) : nativeGet.call(nativeManaged, keys); })
          .catch(function (e) {
            if (!/managed storage manifest not found/i.test(errorMessage(e))) throw e;
            var defaults = {};
            if (keys && typeof keys === "object" && !Array.isArray(keys)) {
              Object.keys(keys).forEach(function (k) { defaults[k] = keys[k]; });
            }
            return defaults;
          });
        return respond(ns, p, cb);
      });
    });
  }

  // ── runtime.onInstalled for an add-on loaded temporarily ───────────────────
  // Firefox fires onInstalled with reason "install" each time it loads a
  // temporary add-on, so an extension loaded that way at every Firefox start
  // would open its welcome page at every start. The background keeps the last
  // version it was told about in localStorage, which outlasts a load when the
  // profile keeps uninstalled add-ons' storage. A repeat of the same version
  // becomes Chrome's "chrome_update", after which extensions redo their setup
  // but welcome no one; a new version becomes an "update".
  function installOnInstalledRepeats() {
    if (!isBackground || !localStore) return;
    var KEY = "__viaduct_installed_version__";
    var version = "";
    try { version = String(api.runtime.getManifest().version || ""); } catch (e) {}
    var change = null;
    function rewrite(details) {
      if (!details || details.temporary !== true) return details;
      if (change === null) {
        var last = null;
        try { last = localStore.getItem(KEY); } catch (e) {}
        try { localStore.setItem(KEY, version); } catch (e) {}
        change = last === null ? {} : last === version ? { reason: "chrome_update" } : { reason: "update", previousVersion: last };
      }
      if (details.reason !== "install") return details;
      var out = {};
      Object.keys(details).forEach(function (k) { out[k] = details[k]; });
      Object.keys(change).forEach(function (k) { out[k] = change[k]; });
      return out;
    }
    namespaces.forEach(function (ns) {
      var ev = ns.runtime && ns.runtime.onInstalled;
      if (!ev || typeof ev.addListener !== "function" || ev.__viaductRepeats) return;
      var add = ev.addListener, remove = ev.removeListener, has = ev.hasListener;
      var wrappers = new WeakMap();
      function wrapperOf(fn) {
        if (typeof fn !== "function") return fn;
        var w = wrappers.get(fn);
        if (!w) {
          w = function (details) { return fn.call(this, rewrite(details)); };
          wrappers.set(fn, w);
        }
        return w;
      }
      replaceMember(ev, "addListener", function (fn) { return add.call(ev, wrapperOf(fn)); });
      replaceMember(ev, "removeListener", function (fn) { return remove.call(ev, wrappers.get(fn) || fn); });
      replaceMember(ev, "hasListener", function (fn) { return has.call(ev, wrappers.get(fn) || fn); });
      replaceMember(ev, "__viaductRepeats", true);
    });
  }

  try { installSidePanel(); } catch (e) { dbg("sidePanel shim failed:", errorMessage(e)); }
  try { installOffscreen(); } catch (e) { dbg("offscreen shim failed:", errorMessage(e)); }
  try { installIdentity(); } catch (e) { dbg("identity shim failed:", errorMessage(e)); }
  try { installFavicon(); } catch (e) { dbg("favicon shim failed:", errorMessage(e)); }
  try { installServiceWorkerScope(); } catch (e) { dbg("ServiceWorkerGlobalScope shim failed:", errorMessage(e)); }
  try { installAssignableStorageGlobals(); } catch (e) { dbg("assignable storage globals failed:", errorMessage(e)); }
  try { installServiceWorkerRegistration(); } catch (e) { dbg("registration shim failed:", errorMessage(e)); }
  try { installServiceWorkerClients(); } catch (e) { dbg("clients shim failed:", errorMessage(e)); }
  try { installServiceWorkerContainer(); } catch (e) { dbg("navigator.serviceWorker shim failed:", errorMessage(e)); }
  try { installServiceWorkerLifecycle(); } catch (e) { dbg("worker lifecycle shim failed:", errorMessage(e)); }
  try { installServiceWorkerLocks(); } catch (e) { dbg("Web Locks shim failed:", errorMessage(e)); }
  try { installServiceWorkerManifest(); } catch (e) { dbg("getManifest service_worker shim failed:", errorMessage(e)); }
  try { installChromeUrls(); } catch (e) { dbg("chrome:// URL shim failed:", errorMessage(e)); }
  try { installBackendOrigin(); } catch (e) { dbg("backend origin shim failed:", errorMessage(e)); }
  try { installEnums(); } catch (e) { dbg("enum shim failed:", errorMessage(e)); }
  try { installRuleFilter(); } catch (e) { dbg("declarativeNetRequest rule filter failed:", errorMessage(e)); }
  try { installGetContexts(); } catch (e) { dbg("getContexts shim failed:", errorMessage(e)); }
  try { installSessionAccessLevel(); } catch (e) { dbg("storage.session.setAccessLevel shim failed:", errorMessage(e)); }
  try { installWindowChrome(); } catch (e) { dbg("window.chrome shim failed:", errorMessage(e)); }
  try { installOwnIdSelectors(); } catch (e) { dbg("own ID selector shim failed:", errorMessage(e)); }
  try { installPageEventDetail(); } catch (e) { dbg("CustomEvent detail shim failed:", errorMessage(e)); }
  try { installContentBodyJson(); } catch (e) { dbg("content json() shim failed:", errorMessage(e)); }
  try { installBrowserActionAlias(); } catch (e) { dbg("browserAction alias failed:", errorMessage(e)); }
  try { installDefaultCookieStore(); } catch (e) { dbg("default cookie store shim failed:", errorMessage(e)); }
  try { installManagedStorage(); } catch (e) { dbg("storage.managed shim failed:", errorMessage(e)); }
  try { installUserScriptEvents(); } catch (e) { dbg("userScripts shim failed:", errorMessage(e)); }
  try { installOnInstalledRepeats(); } catch (e) { dbg("onInstalled shim failed:", errorMessage(e)); }
  try { installWorkerChunks(); } catch (e) { dbg("worker chunk shim failed:", errorMessage(e)); }
  try { installPermissions(); } catch (e) { dbg("permissions shim failed:", errorMessage(e)); }
  try { installWebRequestExtraHeaders(); } catch (e) { dbg("webRequest extraHeaders shim failed:", errorMessage(e)); }
  try { installMenuActionContext(); } catch (e) { dbg("menu action context shim failed:", errorMessage(e)); }
  try { installFalsyListenerArgs(); } catch (e) { dbg("falsy listener argument shim failed:", errorMessage(e)); }
  try { installMessageJsonFallback(); } catch (e) { dbg("message JSON fallback failed:", errorMessage(e)); }
  try { installOwnChromeIdMessages(); } catch (e) { dbg("own Chrome ID message shim failed:", errorMessage(e)); }
  try { installExternalSenders(); } catch (e) { dbg("externally_connectable filter failed:", errorMessage(e)); }
  try { installInjectedScriptShim(); } catch (e) { dbg("injected script shim failed:", errorMessage(e)); }
  try { installDeclarativeContent(); } catch (e) { dbg("declarativeContent shim failed:", errorMessage(e)); }
  try { installStorageCloneFallback(); } catch (e) { dbg("storage clone fallback failed:", errorMessage(e)); }
  try { installProxySettings(); } catch (e) { dbg("proxy.settings shim failed:", errorMessage(e)); }
  try { installPromiseOnlyCallbacks(); } catch (e) { dbg("promise-only callback shim failed:", errorMessage(e)); }
  // __SHIM_DEBUGGER__
})();
