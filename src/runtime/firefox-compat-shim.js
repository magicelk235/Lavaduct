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
//   - chrome://newtab URLs, which tabs.create and windows.create refuse;
//   - the add-on's Chrome origin on requests to its own backends;
//   - Chrome's enum objects that Firefox's declarativeNetRequest lacks.
// A member is only defined where Firefox has none, and the parts with side
// effects are only emitted for an add-on whose code needs them. Firefox's own
// methods are wrapped only to translate an argument Chrome accepts and Firefox
// refuses, or to keep the shim's internal messages from the add-on's listeners.
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
  if (!namespaces.length) return;
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
    var frame = null;
    var frameUrl = "";
    var keepAlive = null;
    var Reason = {};
    OFFSCREEN_REASONS.forEach(function (r) { Reason[r] = r; });

    function removeFrame() {
      var f = frame;
      frame = null;
      frameUrl = "";
      if (keepAlive !== null) { clearInterval(keepAlive); keepAlive = null; }
      try { if (f && f.parentNode) f.parentNode.removeChild(f); } catch (e) {}
    }

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
        frameUrl = abs;
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

    // A service worker finds its offscreen document with clients.matchAll(). An
    // event page has no `clients`, so this one knows about the iframe.
    function offscreenClient() {
      if (!frame) return null;
      var f = frame;
      return {
        id: "offscreen-document", type: "window", frameType: "nested", url: frameUrl,
        focused: false, visibilityState: "hidden",
        postMessage: function (data) {
          // A document reads its service worker's messages from
          // navigator.serviceWorker.
          try {
            var w = f.contentWindow;
            w.navigator.serviceWorker.dispatchEvent(new w.MessageEvent("message", { data: data }));
          } catch (e) {}
        },
      };
    }
    defineMissing(G, "clients", {
      matchAll: function () {
        var c = offscreenClient();
        return Promise.resolve(c ? [c] : []);
      },
      get: function (id) {
        var c = offscreenClient();
        return Promise.resolve(c && c.id === id ? c : undefined);
      },
      claim: function () { return Promise.resolve(); },
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
        if (inflight[key]) return inflight[key];
        var interactive = d.interactive === true;
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
        inflight[key] = flow;
        var clear = function () { delete inflight[key]; };
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

  try { installSidePanel(); } catch (e) { dbg("sidePanel shim failed:", errorMessage(e)); }
  try { installOffscreen(); } catch (e) { dbg("offscreen shim failed:", errorMessage(e)); }
  try { installIdentity(); } catch (e) { dbg("identity shim failed:", errorMessage(e)); }
  try { installFavicon(); } catch (e) { dbg("favicon shim failed:", errorMessage(e)); }
  try { installServiceWorkerScope(); } catch (e) { dbg("ServiceWorkerGlobalScope shim failed:", errorMessage(e)); }
  try { installNewTabUrls(); } catch (e) { dbg("new tab URL shim failed:", errorMessage(e)); }
  try { installBackendOrigin(); } catch (e) { dbg("backend origin shim failed:", errorMessage(e)); }
  try { installEnums(); } catch (e) { dbg("enum shim failed:", errorMessage(e)); }
  // __SHIM_DEBUGGER__
})();
