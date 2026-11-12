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
//   - the add-on's Chrome origin on requests to its own backends;
//   - Chrome's enum objects that Firefox's declarativeNetRequest, identity and
//     storage lack;
//   - declarativeNetRequest rules added at runtime that Firefox would refuse;
//   - OFFSCREEN_DOCUMENT in runtime.getContexts, for the offscreen emulation;
//   - storage.session.setAccessLevel, which code waits on;
//   - window.chrome in content scripts;
//   - storage.managed.get() without a policy, which Chrome answers as an empty area;
//   - runtime.onUserScriptMessage/onUserScriptConnect before Firefox's runtime
//     userScripts grant, and Chrome's chrome.runtime in the USER_SCRIPT world;
//   - webpack chunks of a worker bundle, listed ahead of the worker;
//   - runtime.onInstalled's repeated "install" for an add-on that is loaded
//     temporarily again and again.
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
    if (!isExtensionPage) return;
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
  // The event page can't answer the pages' requests the way a worker's fetch
  // handler does, so no page is controlled: `controller` is null and `ready`
  // gives the worker, as for a page Chrome loaded without its worker. Code that
  // reads `controller` as "my requests went through the worker" then asks the
  // worker instead. For the same reason clients.matchAll() lists every page of
  // the add-on whatever includeUncontrolled says.
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
      controller: { value: null, enumerable: true },
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

  // ── chrome://newtab ─────────────────────────────────────────────────────────
  // tabs.create, tabs.update and windows.create refuse chrome:// URLs in Firefox
  // ("Illegal URL"). A bundle that opens Chrome's new tab page gets Firefox's,
  // which those calls open when given no url. Only emitted for a bundle that
  // names chrome://newtab.
  var NEW_TAB_RE = /^chrome:\/\/new-?tab(?:-page)?\/?$/i;

  function installNewTabUrls() {
    if (!CONFIG.newTab) return;
    var isNewTab = function (u) { return typeof u === "string" && NEW_TAB_RE.test(u); };
    function fixed(props) {
      var url = props.url;
      if (!isNewTab(url) && !(Array.isArray(url) && url.some(isNewTab))) return props;
      var copy = Object.assign({}, props);
      var rest = Array.isArray(url) ? url.filter(function (u) { return !isNewTab(u); }) : [];
      if (rest.length) copy.url = rest;
      else delete copy.url;
      return copy;
    }
    function wrap(obj, name) {
      if (!obj || typeof obj[name] !== "function") return;
      var original = obj[name];
      var wrapped = function () {
        var args = Array.prototype.slice.call(arguments);
        for (var i = 0; i < args.length; i++) if (args[i] && typeof args[i] === "object") args[i] = fixed(args[i]);
        return original.apply(obj, args);
      };
      try { Object.defineProperty(obj, name, { value: wrapped, writable: true, configurable: true, enumerable: true }); } catch (e) {}
    }
    namespaces.forEach(function (ns) {
      wrap(ns.tabs, "create");
      wrap(ns.tabs, "update");
      wrap(ns.windows, "create");
    });
  }

  // ── The add-on's origin at its own backends ────────────────────────────────
  // Chrome sends an extension's requests with its chrome-extension://<id> origin,
  // and some backends allow the extension by that name: a WebSocket handshake
  // with Firefox's moz-extension://<random uuid> origin is refused outright.
  // For the hosts the add-on's own content security policy lets it connect to,
  // a session rule gives its requests (and only its: the initiator is this
  // add-on) the Chrome origin they have in Chrome.
  var BACKEND_ORIGIN_RULE_ID = 2147480001;

  function installBackendOrigin() {
    var hosts = Array.isArray(CONFIG.backendHosts) ? CONFIG.backendHosts : [];
    var dnr = api.declarativeNetRequest;
    if (!isBackground || !hosts.length || !CONFIG.extensionId || !dnr || typeof dnr.updateSessionRules !== "function") return;
    var rule = {
      id: BACKEND_ORIGIN_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "origin", operation: "set", value: "chrome-extension://" + String(CONFIG.extensionId).toLowerCase() }],
      },
      condition: { requestDomains: hosts, initiatorDomains: [loc.host], resourceTypes: ["websocket", "xmlhttprequest", "other"] },
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
        if (DNR_DOMAIN_CONDITIONS.indexOf(key) >= 0 && Array.isArray(value)) value = value.map(firefoxDomain);
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

  function installRuleFilter() {
    namespaces.forEach(function (ns) {
      var dnr = null;
      try { dnr = ns.declarativeNetRequest; } catch (e) {}
      if (!dnr || typeof dnr !== "object") return;
      ["updateDynamicRules", "updateSessionRules"].forEach(function (name) {
        var native = dnr[name];
        if (typeof native !== "function") return;
        replaceMember(dnr, name, function (options) {
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
          return native.apply(dnr, args);
        });
      });
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

  // ── storage.session.setAccessLevel ──────────────────────────────────────────
  // Firefox's session area has no setAccessLevel and is never open to content
  // scripts. Code waiting on the call's callback would wait forever, so the call
  // settles here. Content scripts still get no storage.session, which Chrome code
  // has to handle anyway where the access level was never raised.
  var ACCESS_LEVELS = ["TRUSTED_AND_UNTRUSTED_CONTEXTS", "TRUSTED_CONTEXTS"];

  function installSessionAccessLevel() {
    namespaces.forEach(function (ns) {
      var session = null;
      try { session = ns.storage && ns.storage.session; } catch (e) {}
      if (!session) return;
      defineMissing(session, "setAccessLevel", function (details, cb) {
        var level = details && details.accessLevel;
        var p = ACCESS_LEVELS.indexOf(level) >= 0 ? Promise.resolve() : Promise.reject(new Error("Invalid access level: " + level));
        return respond(ns, p, cb);
      });
    });
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
        if (Array.isArray(scripts)) args[0] = scripts.map(withPrelude);
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
    // getScripts reports what was registered, without the prelude.
    var get = us.getScripts;
    if (typeof get === "function") {
      replaceMember(us, "getScripts", function () {
        var p = get.apply(us, arguments);
        var strip = function (list) {
          return Array.isArray(list) ? list.map(function (s) {
            if (s && Array.isArray(s.js) && s.js.length && s.js[0] && s.js[0].code === userScriptWorldPrelude()) {
              var c = {}; for (var k in s) c[k] = s[k]; c.js = s.js.slice(1); return c;
            }
            return s;
          }) : list;
        };
        return p && typeof p.then === "function" ? p.then(strip) : p;
      });
    }
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
      if (isBackground) route();
      else {
        // A suspended event page reads the config when it wakes; one that runs
        // hears the storage event.
        try { var w = api.runtime.getBackgroundPage(); if (w && typeof w.then === "function") w.then(noop, noop); } catch (e) {}
      }
      announce();
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
        save(next);
      };
      if (copy.mode !== "auto_detect") { apply(); return Promise.resolve(); }
      return nativeCall("set", { value: { proxyType: "autoDetect" } }).then(apply, function (e) {
        throw new Error("proxy mode auto_detect needs Firefox's own proxy settings, which Firefox lets an add-on change only when it may run in private windows (" + errorMessage(e) + ")");
      });
    }

    function clearDetails(details) {
      var scope = (details && details.scope) || "regular";
      var next = JSON.parse(JSON.stringify(state));
      var cleared = scope === "regular" || scope === "regular_only" ? next.regular : next.incognito;
      if (scope === "regular" || scope === "regular_only") { delete next.regular; delete next.regularOnly; }
      else delete next.incognito;
      if (cleared) save(next);
      if (!cleared || cleared.mode === "auto_detect") return nativeCall("clear", {}).then(noop, noop);
      return Promise.resolve();
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
  try { installServiceWorkerLocks(); } catch (e) { dbg("Web Locks shim failed:", errorMessage(e)); }
  try { installServiceWorkerManifest(); } catch (e) { dbg("getManifest service_worker shim failed:", errorMessage(e)); }
  try { installNewTabUrls(); } catch (e) { dbg("new tab URL shim failed:", errorMessage(e)); }
  try { installBackendOrigin(); } catch (e) { dbg("backend origin shim failed:", errorMessage(e)); }
  try { installEnums(); } catch (e) { dbg("enum shim failed:", errorMessage(e)); }
  try { installRuleFilter(); } catch (e) { dbg("declarativeNetRequest rule filter failed:", errorMessage(e)); }
  try { installGetContexts(); } catch (e) { dbg("getContexts shim failed:", errorMessage(e)); }
  try { installSessionAccessLevel(); } catch (e) { dbg("storage.session.setAccessLevel shim failed:", errorMessage(e)); }
  try { installWindowChrome(); } catch (e) { dbg("window.chrome shim failed:", errorMessage(e)); }
  try { installManagedStorage(); } catch (e) { dbg("storage.managed shim failed:", errorMessage(e)); }
  try { installUserScriptEvents(); } catch (e) { dbg("userScripts shim failed:", errorMessage(e)); }
  try { installOnInstalledRepeats(); } catch (e) { dbg("onInstalled shim failed:", errorMessage(e)); }
  try { installWorkerChunks(); } catch (e) { dbg("worker chunk shim failed:", errorMessage(e)); }
  try { installPermissions(); } catch (e) { dbg("permissions shim failed:", errorMessage(e)); }
  try { installWebRequestExtraHeaders(); } catch (e) { dbg("webRequest extraHeaders shim failed:", errorMessage(e)); }
  try { installMessageJsonFallback(); } catch (e) { dbg("message JSON fallback failed:", errorMessage(e)); }
  try { installStorageCloneFallback(); } catch (e) { dbg("storage clone fallback failed:", errorMessage(e)); }
  try { installProxySettings(); } catch (e) { dbg("proxy.settings shim failed:", errorMessage(e)); }
  // __SHIM_DEBUGGER__
})();
