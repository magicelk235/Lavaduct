
  // In a frame whose parent is this add-on's own page, hand the add-on's
  // origin to the page-world half (page-bridge.js), which shows that parent to
  // the page as the extension's Chrome origin. This script runs first, before
  // any of the page's scripts, and the page-world half takes the value back
  // out at once.
  (function () {
    try {
      if (window.top === window) return;
      var own = String(api.runtime.getURL("/")).replace(/\/+$/, "");
      var ancestors = location.ancestorOrigins;
      if (!ancestors || !ancestors.length || ancestors[0] !== own) return;
      Object.defineProperty(window.wrappedJSObject, "__pageBridge:" + CHANNEL + ":frameParent", { value: own, configurable: true });
    } catch (e) {
      DBG("[page-bridge] couldn't pass the frame's parent on:", e);
    }
  })();
