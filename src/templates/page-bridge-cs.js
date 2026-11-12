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
  var DEBUG = function () { try { return !!(typeof globalThis !== "undefined" && globalThis.__pageBridgeDebug); } catch (e) { return false; } };
  var DBG = function () { if (DEBUG()) try { console.log.apply(console, arguments); } catch (e) {} };
  // __FRAME_VIEW__

  // Chrome keeps a page's message open for as long as a listener holds on to
  // its answer (a sign-in finished in another window takes minutes), so the
  // relay sets no deadline of its own: the answer comes back, or the port
  // closes when the background goes away. The page hears at once that the
  // relay has the request, so its own deadline only covers a page the relay
  // never heard.
  window.addEventListener(REQUEST_EVENT, function (ev) {
    var d = null;
    try { d = JSON.parse(String(ev.detail)); } catch (e) { return; }
    if (!d || typeof d.reqId !== "string") return;
    var reqId = d.reqId;
    window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: JSON.stringify({ reqId: reqId, ack: true }) }));

    var port = null;
    var settled = false;
    function reply(response, error) {
      if (settled) return;
      settled = true;
      try { if (port) port.disconnect(); } catch (e) {}
      var detail;
      try {
        detail = JSON.stringify({ reqId: reqId, response: response, error: error || undefined });
      } catch (e) {
        detail = JSON.stringify({ reqId: reqId, error: "The extension's response could not be serialized." });
      }
      window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: detail }));
    }
    try {
      port = api.runtime.connect({ name: PORT_NAME });
      port.onMessage.addListener(function (m) {
        if (!m || m.__pageBridgeReply !== true) return;
        reply(m.response, typeof m.error === "string" ? m.error : null);
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
