// Content-script half of the page bridge (see page-bridge.js), on the
// externally_connectable origins. Takes each request the page dispatches,
// carries it to the background over its own port and dispatches the answer back
// to the page.
//
// A port rather than runtime.sendMessage: in Firefox the first onMessage
// listener to return a promise answers the message, and an extension's async
// listeners return one for every message, so a sendMessage relay would lose the
// real answer to them.
(function () {
  "use strict";
  var api = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
  if (!api || !api.runtime || typeof api.runtime.connect !== "function") return;

  var CHANNEL = "__BRIDGE_CHANNEL__";
  var REQUEST_EVENT = "__pageBridge:" + CHANNEL + ":request";
  var RESPONSE_EVENT = "__pageBridge:" + CHANNEL + ":response";
  var PORT_NAME = "__pageBridge";
  var TIMEOUT_MS = 30000;
  var DEBUG = function () { try { return !!(typeof globalThis !== "undefined" && globalThis.__pageBridgeDebug); } catch (e) { return false; } };
  var DBG = function () { if (DEBUG()) try { console.log.apply(console, arguments); } catch (e) {} };
  // __FRAME_VIEW__

  window.addEventListener(REQUEST_EVENT, function (ev) {
    var d = null;
    try { d = JSON.parse(String(ev.detail)); } catch (e) { return; }
    if (!d || typeof d.reqId !== "string") return;
    var reqId = d.reqId;

    var port = null;
    var settled = false;
    var timer = null;
    function reply(response, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (port) port.disconnect(); } catch (e) {}
      var detail;
      try {
        detail = JSON.stringify({ reqId: reqId, response: response, error: error || undefined });
      } catch (e) {
        detail = JSON.stringify({ reqId: reqId, error: "The extension's response could not be serialized." });
      }
      window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: detail }));
    }
    timer = setTimeout(function () { reply(undefined, "No response from the extension."); }, TIMEOUT_MS);
    try {
      port = api.runtime.connect({ name: PORT_NAME });
      port.onMessage.addListener(function (m) {
        if (!m || m.__pageBridgeReply !== true) return;
        reply(m.response, null);
      });
      port.onDisconnect.addListener(function () {
        var err = null;
        try { err = (port && port.error && port.error.message) || (api.runtime.lastError && api.runtime.lastError.message); } catch (e) {}
        reply(undefined, err || "The extension closed the connection without answering.");
      });
      DBG("[page-bridge] relaying page message", reqId);
      port.postMessage({ __pageBridgeRequest: true, payload: d.msg === undefined ? null : d.msg });
    } catch (e) {
      reply(undefined, String((e && e.message) || e));
    }
  });
})();
