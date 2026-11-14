// Persistent debug ring buffer. This file is not staged on its own: writeShim()
// splices it into the compat shim, over the marker line inside the shim's
// function, only for a --debug conversion, so a release shim carries no trace of
// it. It runs before any of the shim's own blocks, and nothing here may throw.
//
// Every traced line becomes { t: epoch-ms, ctx: "background"|"content"|"page", msg },
// batched behind one timer per flush window so logging can never hammer storage,
// and persisted to storage.local under __viaduct_debug_log__, capped to the last
// 2000 entries. `--logs <add-on>` reads them back out of the Firefox profile.
var __SHIM_DEBUG_WRITE__ = (function () {
  try {
    var KEY = "__viaduct_debug_log__";
    var CAP = 2000;
    // One entry's text, so a logged response body or a huge object can't make
    // every flush read and rewrite megabytes, or push the log past its quota.
    var MSG_CAP = 4000;
    var FLUSH_MS = 1000;
    var api = null;
    try {
      api = (typeof browser !== "undefined" && browser && browser.storage && browser.storage.local) ? browser
        : ((typeof chrome !== "undefined" && chrome && chrome.storage && chrome.storage.local) ? chrome : null);
    } catch (e) {}
    // The page-bridge scripts check this flag when they log; light them up
    // wherever the shim runs so a --debug build gets their diagnostics too.
    try { if (typeof globalThis !== "undefined") globalThis.__pageBridgeDebug = true; } catch (e) {}
    // Content scripts see the web page's location; extension pages are
    // moz-extension: documents, and the background is the page Firefox generates
    // for background.scripts or the manifest's background.page.
    var ctx = "content";
    try {
      var where = typeof location !== "undefined" ? location : null;
      if (where && where.protocol === "moz-extension:") {
        ctx = "page";
        var top = true;
        try { top = typeof window === "undefined" || window.top === window; } catch (e) { top = false; }
        if (top) {
          var bgPage = "";
          try {
            var bg = api && api.runtime && api.runtime.getManifest().background;
            if (bg && typeof bg.page === "string") bgPage = "/" + bg.page.replace(/^\/+/, "");
          } catch (e) {}
          if (where.pathname === "/_generated_background_page.html" || (bgPage && where.pathname === bgPage)) ctx = "background";
        }
      }
    } catch (e) {}
    var pending = [];
    var timer = null;
    function fmt(a) {
      try {
        if (typeof a === "string") return a;
        if (a instanceof Error) return String(a.message || a);
        return JSON.stringify(a);
      } catch (e) { try { return String(a); } catch (e2) { return "<unprintable>"; } }
    }
    function persist(batch) {
      if (!api) return;
      // A storage area may call the trailing callback, resolve a promise, or both;
      // merge exactly once.
      var done = false;
      var merge = function (res) {
        if (done) return;
        done = true;
        try {
          var arr = (res && res[KEY]) || [];
          if (!Array.isArray(arr)) arr = [];
          arr = arr.concat(batch);
          if (arr.length > CAP) arr = arr.slice(arr.length - CAP);
          var obj = {};
          obj[KEY] = arr;
          try {
            var p = api.storage.local.set(obj, function () { try { void (api.runtime && api.runtime.lastError); } catch (e) {} });
            if (p && typeof p.catch === "function") p.catch(function () {});
          } catch (e) {}
        } catch (e) {}
      };
      try {
        var r = api.storage.local.get(KEY, function (res) {
          try { void (api.runtime && api.runtime.lastError); } catch (e) {}
          merge(res);
        });
        if (r && typeof r.then === "function") r.then(merge, function () {});
      } catch (e) {
        // A promise-only storage area that rejects a trailing callback argument.
        try { api.storage.local.get(KEY).then(merge, function () {}); } catch (e2) {}
      }
    }
    function flush() {
      timer = null;
      if (!pending.length) return;
      var batch = pending;
      pending = [];
      try { persist(batch); } catch (e) {}
    }
    var write = function (args) {
      try {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(fmt(args[i]));
        var msg = parts.join(" ");
        if (msg.length > MSG_CAP) msg = msg.slice(0, MSG_CAP) + "... [" + (msg.length - MSG_CAP) + " more chars]";
        pending.push({ t: Date.now(), ctx: ctx, msg: msg });
        if (pending.length > CAP) pending.splice(0, pending.length - CAP);
        if (timer == null) timer = setTimeout(flush, FLUSH_MS);
      } catch (e) {}
    };
    // An uncaught error in the host script is the most useful thing to see and the
    // hardest to reach: it aborts the rest of that script (a background stops
    // registering its listeners). Tee both failure channels into the ring so
    // `--logs` shows them. Not in a content script: there `self` is the web page's
    // window, which hears the page's own errors and rejections, and Firefox never
    // dispatches a content script's there, so every entry would be the site's.
    try {
      var target = ctx === "content" ? null
        : (typeof self !== "undefined" && self && self.addEventListener) ? self
        : ((typeof window !== "undefined" && window && window.addEventListener) ? window : null);
      if (target) {
        target.addEventListener("error", function (e) {
          try {
            var m = (e && (e.message || (e.error && e.error.message))) || "error";
            var at = (e && e.filename) ? " @" + e.filename + ":" + e.lineno + ":" + e.colno : "";
            write(["[uncaught] " + m + at]);
          } catch (e2) {}
        });
        target.addEventListener("unhandledrejection", function (e) {
          try {
            var r = e && e.reason;
            write(["[unhandled rejection] " + ((r && (r.message || r)) || "unknown")]);
          } catch (e2) {}
        });
      }
    } catch (e) {}
    // The extension's own caught failures usually end in console.error/warn; tee
    // those too. The shim's own traces go to console.log, which stays untouched.
    // The console object is held here, not looked up per call: LavaMoat's
    // scuttling (MetaMask) turns globalThis.console into a throwing getter after
    // startup while the bundle keeps logging through its own reference. The tee
    // is defined, not assigned: in a content script an assigned console method
    // turns read-only, and the bundle's own wrapping of it would throw.
    try {
      if (typeof console !== "undefined") {
        var con = console;
        ["error", "warn"].forEach(function (level) {
          var orig = con[level];
          if (typeof orig !== "function" || orig.__debugRingTee) return;
          var teed = function () {
            try { write(["[console." + level + "]"].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
            return orig.apply(con, arguments);
          };
          teed.__debugRingTee = true;
          var desc = Object.getOwnPropertyDescriptor(con, level);
          try {
            Object.defineProperty(con, level, { value: teed, writable: true, configurable: true, enumerable: !desc || desc.enumerable === true });
          } catch (e) {
            con[level] = teed;
          }
        });
      }
    } catch (e) {}
    return write;
  } catch (e) {
    return function () {};
  }
})();
