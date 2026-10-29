
  // ── Frames whose parent is this add-on ─────────────────────────────────────
  // In Chrome the extension's pages are chrome-extension://<id>, and a page
  // they frame can tell its parent by that origin: the parent's messages carry
  // it, location.ancestorOrigins lists it, and the page posts back to it. In
  // Firefox the parent is moz-extension://<uuid>. In a frame whose parent is
  // this add-on (the content-script half checked that and handed the origin
  // over), the page sees that parent as the Chrome origin instead:
  //   - MessageEvent.origin of the parent's messages reads the Chrome origin;
  //   - postMessage to the parent with the Chrome origin as target reaches it;
  //   - location.ancestorOrigins can't be changed, so a pattern test of the
  //     parent's origin read from it (string match, RegExp test) is answered
  //     for the Chrome origin when the pattern looks for chrome-extension.
  // Nothing changes in any other frame, or for any other origin.
  (function () {
    var key = "__pageBridge:" + CHANNEL + ":frameParent";
    var own = null;
    try {
      own = window[key];
      delete window[key];
    } catch (e) { return; }
    if (typeof own !== "string" || !own || !CHROME_ID) return;
    var chromeOrigin = "chrome-extension://" + CHROME_ID;
    try {
      var parentWindow = window.parent;
      var originOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "origin").get;
      var sourceOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "source").get;
      var regexSource = Object.getOwnPropertyDescriptor(RegExp.prototype, "source").get;
      var nativeMatch = String.prototype.match;
      var nativeTest = RegExp.prototype.test;
      var CHROME_PATTERN = /chrome-extension/i;

      var postToParent = function postMessage(message, targetOrigin) {
        "use strict";
        var args = Array.prototype.slice.call(arguments);
        if (args[1] === chromeOrigin) args[1] = own;
        else if (args[1] && typeof args[1] === "object" && args[1].targetOrigin === chromeOrigin) {
          args[1] = Object.assign({}, args[1], { targetOrigin: own });
        }
        return parentWindow.postMessage.apply(parentWindow, args);
      };
      var parentView = new Proxy(parentWindow, {
        get: function (target, prop) { return prop === "postMessage" ? postToParent : Reflect.get(target, prop); },
        set: function (target, prop, value) { return Reflect.set(target, prop, value); },
      });

      Object.defineProperty(MessageEvent.prototype, "origin", {
        configurable: true,
        enumerable: true,
        get: function origin() {
          var o = originOf.call(this);
          return o === own ? chromeOrigin : o;
        },
      });
      Object.defineProperty(MessageEvent.prototype, "source", {
        configurable: true,
        enumerable: true,
        get: function source() {
          var s = sourceOf.call(this);
          return s === parentWindow ? parentView : s;
        },
      });
      Object.defineProperty(window, "parent", {
        configurable: true,
        enumerable: true,
        get: function parent() { return parentView; },
        set: function (value) {
          Object.defineProperty(window, "parent", { value: value, writable: true, configurable: true, enumerable: true });
        },
      });

      var looksForChrome = function (re) {
        try { return re instanceof RegExp && nativeTest.call(CHROME_PATTERN, regexSource.call(re)); } catch (e) { return false; }
      };
      String.prototype.match = function match(regexp) {
        "use strict";
        return nativeMatch.call(this === own && looksForChrome(regexp) ? chromeOrigin : this, regexp);
      };
      RegExp.prototype.test = function test(string) {
        "use strict";
        return nativeTest.call(this, string === own && looksForChrome(this) ? chromeOrigin : string);
      };
      DBG("[page-bridge] this frame's parent reads as", chromeOrigin);
    } catch (e) {
      DBG("[page-bridge] couldn't show the frame's parent as", chromeOrigin, e);
    }
  })();
