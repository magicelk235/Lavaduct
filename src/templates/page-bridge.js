// Page half of the bridge, run in the page's own JavaScript world on the
// externally_connectable origins. Chrome gives those pages
// chrome.runtime.sendMessage(<extension id>, message, callback); Firefox ignores
// externally_connectable and gives web pages no chrome.runtime at all. This
// provides sendMessage and hands each message to the add-on's content script
// (page-bridge-cs.js).
//
// The two talk through DOM events on `window` carrying JSON strings. Unlike
// window.postMessage, no other frame can dispatch them, and in Firefox a message
// posted by a content script arrives with no source and an empty origin, so it
// couldn't be checked anyway. Chrome serializes external messages as JSON too.
(function () {
  var CHROME_ID = "__EXTENSION_ID__";
  if (CHROME_ID === "__EXTENSION" + "_ID__") CHROME_ID = "";
  var CHANNEL = "__BRIDGE_CHANNEL__";
  var REQUEST_EVENT = "__pageBridge:" + CHANNEL + ":request";
  var RESPONSE_EVENT = "__pageBridge:" + CHANNEL + ":response";
  var DEBUG = function () { try { return !!window.__pageBridgeDebug; } catch (e) { return false; } };
  var DBG = function () { if (DEBUG()) try { console.log.apply(console, arguments); } catch (e) {} };
  // __FRAME_VIEW__

  var ns = window.chrome || {};
  var runtime = ns.runtime || {};
  // Shared by every converted add-on that bridges this page.
  var state = runtime.__pageBridgeState;
  if (!state) {
    state = { channels: [], lastError: undefined };
    Object.defineProperty(runtime, "__pageBridgeState", { value: state, configurable: true });
    if (!("lastError" in runtime)) {
      // Like Chrome's runtime.lastError: set only while a callback runs.
      Object.defineProperty(runtime, "lastError", { get: function () { return state.lastError; }, configurable: true, enumerable: true });
    }
  }
  if (state.channels.indexOf(CHANNEL) >= 0) return;
  state.channels.push(CHANNEL);
  // Messages for a different extension id go to the add-on that bridged the
  // page before this one; with none, they fail the way Chrome's do when no
  // such extension is installed.
  var previous = typeof runtime.sendMessage === "function" ? runtime.sendMessage : null;

  var pending = Object.create(null);
  var seq = 0;

  window.addEventListener(RESPONSE_EVENT, function (ev) {
    var d = null;
    try { d = JSON.parse(String(ev.detail)); } catch (e) { return; }
    var done = d && pending[d.reqId];
    if (!done) return;
    delete pending[d.reqId];
    done(d.response, d.error);
  });

  function sendMessage() {
    var args = Array.prototype.slice.call(arguments);
    var target = typeof args[0] === "string" ? args[0] : null;
    var elsewhere = target !== null && CHROME_ID && target !== CHROME_ID;
    if (elsewhere && previous) return previous.apply(this, args);
    // (extensionId, message[, options][, callback]) or (message[, callback])
    var msg = target !== null ? args[1] : args[0];
    var cb = null;
    for (var i = args.length - 1; i > 0; i--) {
      if (typeof args[i] === "function") { cb = args[i]; break; }
    }
    var reqId = "r" + (++seq);
    var p = elsewhere ? Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")) : new Promise(function (resolve, reject) {
      var detail;
      try {
        detail = JSON.stringify({ reqId: reqId, msg: msg });
      } catch (e) {
        reject(new Error("Message could not be serialized: " + ((e && e.message) || e)));
        return;
      }
      // The relay answers within its own timeout; this one only matters if the
      // relay never got the request.
      var timer = setTimeout(function () {
        if (pending[reqId]) {
          delete pending[reqId];
          reject(new Error("Could not establish connection. Receiving end does not exist."));
        }
      }, 31000);
      pending[reqId] = function (response, error) {
        clearTimeout(timer);
        if (error) reject(new Error(error));
        else resolve(response);
      };
      DBG("[page-bridge] page -> extension", reqId);
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: detail }));
    });
    if (!cb) return p;
    p.then(function (r) {
      cb(r);
    }, function (e) {
      state.lastError = { message: (e && e.message) || "Unknown error" };
      try { cb(undefined); } finally { state.lastError = undefined; }
    });
    return undefined;
  }

  var noop = function () {};
  var inertEvent = { addListener: noop, removeListener: noop, hasListener: function () { return false; } };
  runtime.sendMessage = sendMessage;
  if (typeof runtime.connect !== "function") {
    // Long-lived connections from the page aren't bridged; the port is inert.
    runtime.connect = function () {
      DBG("[page-bridge] runtime.connect from the page is not bridged");
      return { name: "", postMessage: noop, disconnect: noop, onMessage: inertEvent, onDisconnect: inertEvent };
    };
  }
  ns.runtime = runtime;
  window.chrome = ns;
})();
