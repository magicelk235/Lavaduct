// Background half of the page bridge (see page-bridge.js). Chrome delivers a
// message from a page on an externally_connectable origin to the extension's
// runtime.onMessageExternal listeners. Firefox only dispatches that event for
// other add-ons, so this captures the listeners as the extension adds them and
// feeds them what the content-script relay brings in over a dedicated port, with
// the page as the sender.
//
// It must load before the extension's own background code, and it never touches
// messages or ports that aren't its own.
(function () {
  "use strict";
  var G = typeof globalThis !== "undefined" ? globalThis : self;
  try {
    if (G.__pageBridgeReceiver) return;
    Object.defineProperty(G, "__pageBridgeReceiver", { value: true, configurable: true });
  } catch (e) { return; }

  var PORT_NAME = "__pageBridge";
  var DEBUG = function () { try { return !!G.__pageBridgeDebug; } catch (e) { return false; } };
  var DBG = function () { if (DEBUG()) try { console.log.apply(console, arguments); } catch (e) {} };

  // In MV2 `chrome` and `browser` are separate objects with separate events.
  var namespaces = [];
  try { if (typeof browser === "object" && browser) namespaces.push(browser); } catch (e) {}
  try { if (typeof chrome === "object" && chrome && namespaces.indexOf(chrome) < 0) namespaces.push(chrome); } catch (e) {}
  if (!namespaces.length || !namespaces[0].runtime) return;
  var api = namespaces[0];

  var listeners = [];

  function setMethod(obj, name, fn) {
    try { Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true }); } catch (e) {}
    if (obj[name] !== fn) {
      try { obj[name] = fn; } catch (e) {}
    }
    return obj[name] === fn;
  }

  // The listeners stay registered natively as well, so genuine messages from
  // other add-ons keep arriving.
  function capture(ns) {
    var rt = ns.runtime;
    var ev = rt && rt.onMessageExternal;
    if (!ev || typeof ev.addListener !== "function") return;
    var nativeAdd = ev.addListener;
    var nativeRemove = typeof ev.removeListener === "function" ? ev.removeListener : null;
    var nativeHas = typeof ev.hasListener === "function" ? ev.hasListener : null;
    var add = function (fn) {
      if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn);
      return nativeAdd.apply(ev, arguments);
    };
    var remove = function (fn) {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
      return nativeRemove ? nativeRemove.apply(ev, arguments) : undefined;
    };
    if (setMethod(ev, "addListener", add)) {
      setMethod(ev, "removeListener", remove);
      return;
    }
    // The event object's methods can't be replaced; put a forwarding event in
    // its place instead.
    setMethod(rt, "onMessageExternal", {
      addListener: add,
      removeListener: remove,
      hasListener: function (fn) { return nativeHas ? nativeHas.call(ev, fn) : listeners.indexOf(fn) >= 0; },
    });
  }
  namespaces.forEach(capture);

  function originOf(url) {
    try {
      var o = new URL(url).origin;
      return o && o !== "null" ? o : undefined;
    } catch (e) { return undefined; }
  }

  // What Chrome reports for a message from a web page: its URL, origin, tab and
  // frame, and no extension id.
  function pageSender(sender) {
    var s = sender || {};
    var url = s.url || (s.tab && s.tab.url) || "";
    var out = { url: url, origin: originOf(url) || s.origin };
    if (s.tab) out.tab = s.tab;
    if (s.frameId != null) out.frameId = s.frameId;
    if (s.documentId) out.documentId = s.documentId;
    return out;
  }

  // Chrome's contract: a listener answers through sendResponse, keeps the channel
  // open by returning true, or returns a promise. If none will answer, the page
  // gets undefined right away instead of waiting out its timeout.
  function dispatch(payload, sender) {
    return new Promise(function (resolve) {
      var settled = false;
      var sendResponse = function (value) {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      var willRespond = false;
      listeners.slice().forEach(function (fn) {
        try {
          var r = fn(payload, sender, sendResponse);
          if (r === true) willRespond = true;
          else if (r && typeof r.then === "function") {
            willRespond = true;
            r.then(sendResponse, function (err) {
              DBG("[page-bridge] listener rejected:", err);
              sendResponse(undefined);
            });
          }
        } catch (e) {
          console.error("[page-bridge] onMessageExternal listener threw:", e);
        }
      });
      if (!willRespond) sendResponse(undefined);
    });
  }

  api.runtime.onConnect.addListener(function (port) {
    if (!port || port.name !== PORT_NAME) return;
    var sender = pageSender(port.sender);
    port.onMessage.addListener(function (m) {
      if (!m || m.__pageBridgeRequest !== true) return;
      DBG("[page-bridge] page message from", sender.origin, "listeners:", listeners.length);
      dispatch(m.payload, sender).then(function (response) {
        try { port.postMessage({ __pageBridgeReply: true, response: response }); } catch (e) {}
      });
    });
  });
})();
