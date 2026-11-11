  // ── chrome.debugger ─────────────────────────────────────────────────────────
  // writeShim() splices this block into the shim, over the marker line inside the
  // shim's function, only for an add-on that declares the "debugger" permission
  // or calls chrome.debugger. It uses the shim's helpers (namespaces, api,
  // respond, makeEvent, defineMissing, …).
  //
  // Firefox gives add-ons no DevTools protocol. Extensions mostly use the
  // protocol to drive tabs, and Firefox's own extension APIs cover that ground:
  //   - Runtime.evaluate, callFunctionOn and getProperties run in the page through
  //     scripting (world: "MAIN"), with V8's REPL mode emulated. Console calls and
  //     uncaught errors come from a hook put into the page.
  //   - Input.* become DOM events dispatched in the page. They are synthetic
  //     (isTrusted is false, so a page that checks can tell) and carry no user
  //     activation, so a popup a click handler opens is blocked.
  //   - Page.captureScreenshot is tabs.captureTab, which takes clips and works on
  //     background tabs. Navigation and lifecycle events come from webNavigation.
  //   - Network.* events come from webRequest, with real methods and statuses;
  //     response bodies aren't available.
  //   - alert/confirm/prompt are answered in the page (accepted, prompt gets its
  //     default) and reported as Page.javascriptDialogOpening, since a dialog
  //     Firefox shows would block the page and every later command.
  // Pages whose content security policy forbids eval can't run Runtime.evaluate,
  // and cross-origin frames are reached only through Firefox's frame IDs.
  //
  // The background page owns every session. The add-on's other pages (a side
  // panel, a popup) forward their calls to it and hear its events over a
  // BroadcastChannel, so they all agree on what is attached, as in Chrome.
  var CDP_KEY = "__cdpEmulation";
  var CDP_STATE_KEY = CDP_KEY + ":sessions";
  // Name of the page-side registry and of the DOM event that carries page reports
  // to the content-script relay. Derived from the add-on ID so two converted
  // add-ons driving one tab keep apart.
  var CDP_PAGE_KEY = (function () {
    var id = "";
    try { id = String(api.runtime.id || ""); } catch (e) {}
    var h = 5381;
    for (var i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
    return CDP_KEY + "_" + h.toString(16);
  })();
  var CDP_KEEPALIVE_MS = 20000;
  // Firefox's extensions.webextensions.restrictedDomains: pages no add-on may script.
  var CDP_RESTRICTED_HOSTS = [
    "accounts-static.cdn.mozilla.net", "accounts.firefox.com", "addons.cdn.mozilla.net", "addons.mozilla.org",
    "api.accounts.firefox.com", "content.cdn.mozilla.net", "discovery.addons.mozilla.org",
    "install.mozilla.org", "oauth.accounts.firefox.com", "profile.accounts.firefox.com",
    "support.mozilla.org", "sync.services.mozilla.com",
  ];
  // Commands that only switch event reporting on or off, or tune something
  // Firefox has no counterpart for. They succeed and change nothing.
  var CDP_NOOP_RE = new RegExp(
    "^(?:[A-Za-z]+\\.(?:enable|disable)" +
    "|Emulation\\.(?:setFocusEmulationEnabled|setEmulatedMedia|setTouchEmulationEnabled|setScrollbarsHidden" +
    "|setDefaultBackgroundColorOverride|setAutoDarkModeOverride|setUserAgentOverride|setEmulatedVisionDeficiency)" +
    "|Network\\.(?:setCacheDisabled|setBypassServiceWorker|clearBrowserCache)" +
    "|Page\\.(?:setLifecycleEventsEnabled|stopLoading)" +
    "|Runtime\\.(?:runIfWaitingForDebugger|discardConsoleEntries|setAsyncCallStackDepth)" +
    "|Target\\.(?:setDiscoverTargets|setAutoAttach|setRemoteLocations))$"
  );
  // Real protocol methods with no Firefox counterpart, and why.
  var CDP_UNSUPPORTED = {
    "Network.getResponseBody": "response bodies aren't available to add-ons in Firefox",
    "Network.getRequestPostData": "request bodies are only reported in Network.requestWillBeSent",
    "Network.getCookies": "use the cookies API instead",
    "Network.getAllCookies": "use the cookies API instead",
    "Network.setExtraHTTPHeaders": "use declarativeNetRequest instead",
    "Page.printToPDF": "Firefox can only save a tab as PDF to a file (tabs.saveAsPDF)",
    "Page.addScriptToEvaluateOnNewDocument": "Firefox can't register script source at runtime",
    "Page.setBypassCSP": "Firefox can't lift a page's content security policy for add-ons",
    "Fetch.enable": "use webRequest instead",
  };
  // webRequest resource types → DevTools resource types.
  var CDP_RESOURCE_TYPES = {
    main_frame: "Document", sub_frame: "Document", stylesheet: "Stylesheet", script: "Script", image: "Image",
    imageset: "Image", font: "Font", xmlhttprequest: "XHR", ping: "Ping", beacon: "Ping",
    csp_report: "CSPViolationReport", media: "Media", websocket: "WebSocket", web_manifest: "Manifest",
  };

  function protocolError(message, code) {
    return new Error(JSON.stringify({ code: code || -32000, message: String(message) }));
  }

  function cdpTabOf(target) {
    var t = target && typeof target === "object" ? target : {};
    if (typeof t.tabId === "number" && t.tabId >= 0) return t.tabId;
    var id = typeof t.targetId === "string" ? t.targetId : typeof t.sessionId === "string" ? t.sessionId : "";
    var m = /^tab-(\d+)$/.exec(id);
    if (m) return Number(m[1]);
    throw new Error(t.extensionId ? "Cannot attach to this target." : "Either tab id or target id must be specified.");
  }

  function cdpRestricted(url) {
    if (typeof url !== "string" || !url) return false;
    var m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
    if (!m) return false;
    var scheme = m[1].toLowerCase();
    if (scheme === "about") return !/^about:(?:blank|srcdoc)(?:[?#]|$)/i.test(url);
    if (["http", "https", "file", "data", "blob", "ftp", "ws", "wss"].indexOf(scheme) < 0) return true;
    try { return CDP_RESTRICTED_HOSTS.indexOf(new URL(url).hostname) >= 0; } catch (e) { return false; }
  }

  function cdpFrameId(tabId, frameId) {
    return frameId ? tabId + "." + frameId : String(tabId);
  }

  // ── Page-side code ──
  // Both functions are handed to scripting.executeScript, which runs their
  // source in the tab, so neither may use anything from the enclosing scope.

  // Runs in the page's own world: evaluation, the object registry, DOM
  // inspection, and the console and dialog hooks.
  function cdpMain(op, p, key) {
    var W = window;
    var reg = W[key];
    if (!reg || typeof reg !== "object" || !reg.objects) {
      reg = { seq: 0, objects: new Map(), groups: new Map(), nodeIds: new Map(), hooks: {}, report: null };
      try { Object.defineProperty(W, key, { value: reg, configurable: true, writable: true }); } catch (e) { W[key] = reg; }
    }
    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

    function Fail(message) { this.message = message; }
    function store(v, group) {
      var id = "obj-" + (++reg.seq);
      reg.objects.set(id, v);
      if (group) {
        var list = reg.groups.get(group);
        if (!list) reg.groups.set(group, list = []);
        list.push(id);
      }
      return id;
    }
    function className(v) {
      try {
        var c = v.constructor;
        if (c && typeof c.name === "string" && c.name) return c.name;
      } catch (e) {}
      return "Object";
    }
    function isNode(v) {
      try { return typeof v.nodeType === "number" && typeof v.nodeName === "string" && typeof v.cloneNode === "function"; } catch (e) { return false; }
    }
    function isError(v) {
      try { return v instanceof Error || (typeof v.name === "string" && typeof v.message === "string" && "stack" in v); } catch (e) { return false; }
    }
    function subtypeOf(v) {
      try {
        if (Array.isArray(v)) return "array";
        if (isNode(v)) return "node";
        if (isError(v)) return "error";
        var tag = Object.prototype.toString.call(v).slice(8, -1);
        var map = { RegExp: "regexp", Date: "date", Map: "map", Set: "set", WeakMap: "weakmap", WeakSet: "weakset", Promise: "promise", ArrayBuffer: "arraybuffer", DataView: "dataview", Proxy: "proxy" };
        if (map[tag]) return map[tag];
        if (ArrayBuffer.isView(v)) return "typedarray";
      } catch (e) {}
      return "";
    }
    function nodeDescription(n) {
      try {
        if (n.nodeType === 1) {
          var d = String(n.localName || n.nodeName).toLowerCase();
          if (n.id) d += "#" + n.id;
          var cls = typeof n.className === "string" ? n.className.trim() : "";
          if (cls) d += "." + cls.split(/\s+/).join(".");
          return d;
        }
        if (n.nodeType === 10) return "<!DOCTYPE " + n.name + ">";
        return n.nodeName;
      } catch (e) { return "node"; }
    }
    // Firefox's "fn@url:line:col" stack lines, as DevTools call frames.
    function frames(stack, skip) {
      var out = [];
      String(stack || "").split("\n").forEach(function (line) {
        var m = /^(.*?)@(.*):(\d+):(\d+)$/.exec(line.trim());
        if (m) out.push({ functionName: m[1], scriptId: "0", url: m[2], lineNumber: Number(m[3]) - 1, columnNumber: Number(m[4]) - 1 });
      });
      return out.slice(skip || 0, (skip || 0) + 20);
    }
    // V8's rendering of an error: "TypeError: message" and "    at" lines.
    function errorDescription(e, compile) {
      var name = "Error";
      var message = "";
      try { name = String(e.name || className(e)); message = String(e.message); } catch (x) {}
      if (compile && name === "SyntaxError") message = v8SyntaxMessage(message);
      var d = message ? name + ": " + message : name;
      if (!compile) {
        var stack = "";
        try { stack = String(e.stack || ""); } catch (x) {}
        frames(stack).forEach(function (f) {
          var where = f.url + ":" + (f.lineNumber + 1) + ":" + (f.columnNumber + 1);
          d += "\n    at " + (f.functionName ? f.functionName + " (" + where + ")" : where);
        });
      }
      return d;
    }
    // Clients match V8's wording; Firefox words two common syntax errors differently.
    function v8SyntaxMessage(m) {
      if (/^return not in function$/.test(m)) return "Illegal return statement";
      if (/^await is only valid in async functions/.test(m)) return "await is only valid in async functions and the top level bodies of modules";
      return m;
    }
    function describe(v, sub) {
      try {
        if (sub === "array") return "Array(" + v.length + ")";
        if (sub === "error") return errorDescription(v, false);
        if (sub === "node") return nodeDescription(v);
        if (sub === "date" || sub === "regexp") return String(v);
        if (sub === "map" || sub === "set") return className(v) + "(" + v.size + ")";
        if (sub === "typedarray") return className(v) + "(" + v.length + ")";
      } catch (e) {}
      return className(v);
    }
    function byValue(v) {
      var json;
      try { json = JSON.stringify(v); } catch (e) {
        throw new Fail(/cyclic|circular/i.test(String(e && e.message)) ? "Object reference chain is too long" : "Object couldn't be returned by value");
      }
      return json === undefined ? undefined : JSON.parse(json);
    }
    function remote(v, wantValue, group) {
      var t = typeof v;
      if (v === undefined) return { type: "undefined" };
      if (v === null) return { type: "object", subtype: "null", value: null };
      if (t === "string" || t === "boolean") return { type: t, value: v };
      if (t === "number") {
        if (v !== v || v === Infinity || v === -Infinity || (v === 0 && 1 / v < 0)) {
          var u = v === 0 ? "-0" : String(v);
          return { type: "number", unserializableValue: u, description: u };
        }
        return { type: "number", value: v, description: String(v) };
      }
      if (t === "bigint") return { type: "bigint", unserializableValue: String(v) + "n", description: String(v) + "n" };
      if (t === "symbol") return { type: "symbol", description: String(v), objectId: store(v, group) };
      if (t === "function") {
        var src = "";
        try { src = Function.prototype.toString.call(v); } catch (e) {}
        var fn = { type: "function", className: className(v), description: src.length > 2000 ? src.slice(0, 2000) + "…" : src };
        if (!wantValue) fn.objectId = store(v, group);
        return fn;
      }
      var sub = subtypeOf(v);
      if (sub === "node") return { type: "object", subtype: "node", className: className(v), description: nodeDescription(v), objectId: store(v, group) };
      if (wantValue) return { type: "object", value: byValue(v) };
      var out = { type: "object", className: className(v), description: describe(v, sub), objectId: store(v, group) };
      if (sub) out.subtype = sub;
      return out;
    }
    function exceptionDetails(e, compile, group, inPromise) {
      var exception;
      if (isError(e)) {
        exception = { type: "object", subtype: "error", className: "Error", description: errorDescription(e, compile), objectId: store(e, group) };
        try { exception.className = String(e.name || className(e)); } catch (x) {}
      } else {
        exception = remote(e, false, group);
      }
      var d = {
        exceptionId: ++reg.seq,
        text: inPromise ? "Uncaught (in promise)" : "Uncaught",
        lineNumber: 0,
        columnNumber: 0,
        scriptId: String(reg.seq),
        exception: exception,
      };
      try {
        if (typeof e.lineNumber === "number") d.lineNumber = Math.max(0, e.lineNumber - 1);
        if (typeof e.columnNumber === "number") d.columnNumber = Math.max(0, e.columnNumber);
      } catch (x) {}
      // V8 reports where a runtime error was thrown; a script that doesn't
      // compile has no stack, which is how clients tell the two apart.
      if (!compile) d.stackTrace = { callFrames: isError(e) ? frames(e.stack) : [] };
      return d;
    }
    function thrown(e, group, compile, inPromise) {
      return { result: remote(e, false, group), exceptionDetails: exceptionDetails(e, compile, group, inPromise) };
    }
    // A page may have replaced window.Promise (zone.js does); Firefox awaits
    // only a native promise, which an async function always returns.
    function settle(value, wantValue, group, wait) {
      if (wait && value && typeof value.then === "function") {
        return (async function () {
          var v;
          try { v = await value; } catch (e) { return thrown(e, group, false, true); }
          try { return { result: remote(v, wantValue, group) }; } catch (e) {
            if (e instanceof Fail) return { __protocolError: e.message };
            throw e;
          }
        })();
      }
      return { result: remote(value, wantValue, group) };
    }
    function isSyntaxError(e) {
      try { return !!e && e.name === "SyntaxError"; } catch (x) { return false; }
    }

    // Statement boundaries at the top level of `src`: where a statement may
    // start, and where the last significant token ends. Strings, templates,
    // comments and regular expressions are skipped.
    function scanTop(src) {
      var n = src.length;
      var i = 0;
      var depth = 0;
      var templates = [];
      var starts = [];
      var prev = "";
      var word = "";
      var end = 0;
      var REGEX_AFTER = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
      function inTemplate() {
        while (i < n) {
          var ch = src.charAt(i);
          if (ch === "\\") { i += 2; continue; }
          if (ch === "`") { i++; return false; }
          if (ch === "$" && src.charAt(i + 1) === "{") { i += 2; templates.push(depth); depth++; return true; }
          i++;
        }
        return false;
      }
      function skipQuoted(q) {
        i++;
        while (i < n) {
          var ch = src.charAt(i);
          if (ch === "\\") { i += 2; continue; }
          i++;
          if (ch === q || ch === "\n") return;
        }
      }
      function skipRegex() {
        var cls = false;
        i++;
        while (i < n) {
          var ch = src.charAt(i);
          if (ch === "\\") { i += 2; continue; }
          if (ch === "\n") return;
          i++;
          if (cls) { if (ch === "]") cls = false; } else if (ch === "[") cls = true;
          else if (ch === "/") break;
        }
        while (i < n && /[A-Za-z]/.test(src.charAt(i))) i++;
      }
      while (i < n) {
        var c = src.charAt(i);
        if (c === "/" && src.charAt(i + 1) === "/") {
          var nl = src.indexOf("\n", i);
          i = nl < 0 ? n : nl;
          continue;
        }
        if (c === "/" && src.charAt(i + 1) === "*") {
          var close = src.indexOf("*/", i + 2);
          i = close < 0 ? n : close + 2;
          continue;
        }
        if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") {
          if (depth === 0) starts.push({ at: i + 1, kind: "line" });
          i++;
          continue;
        }
        if (/\s/.test(c)) { i++; continue; }
        if (c === "`") {
          i++;
          if (!inTemplate()) { prev = "`"; word = ""; end = i; }
          continue;
        }
        if (c === "}" && templates.length && templates[templates.length - 1] === depth - 1) {
          depth--;
          templates.pop();
          i++;
          if (!inTemplate()) { prev = "`"; word = ""; end = i; }
          continue;
        }
        if (c === "'" || c === '"') { skipQuoted(c); prev = c; word = ""; end = i; continue; }
        if (c === "/" && (prev === "" || (prev === "w" ? REGEX_AFTER.test(word) : ")]`'\"".indexOf(prev) < 0 && prev !== "r"))) {
          skipRegex();
          prev = "r";
          word = "";
          end = i;
          continue;
        }
        if (/[\w$\u0080-\uffff]/.test(c)) {
          var j = i;
          while (j < n && /[\w$\u0080-\uffff]/.test(src.charAt(j))) j++;
          word = src.slice(i, j);
          prev = "w";
          i = j;
          end = i;
          continue;
        }
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          if (depth > 0) depth--;
          if (c === "}" && depth === 0) starts.push({ at: i + 1, kind: "block" });
        } else if (c === ";" && depth === 0) {
          starts.push({ at: i + 1, kind: "semicolon" });
        }
        prev = c;
        word = "";
        i++;
        if (c !== ";") end = i;
      }
      return { starts: starts, end: end };
    }

    // V8's REPL mode for code with top-level await: an async function whose
    // value is that of the code's last expression statement.
    function replFunction(code) {
      var body = code;
      var t = code.trim();
      if (t.charAt(0) === "{" && t.charAt(t.length - 1) === "}") {
        var outer = scanTop(t).starts.filter(function (s) { return s.kind !== "line"; });
        if (outer.length && outer[0].at === t.length) body = t.slice(1, -1);
      }
      var scan = scanTop(body);
      var end = scan.end;
      var candidates = scan.starts.filter(function (s) { return s.at < end; }).reverse();
      candidates.push({ at: 0, kind: "semicolon" });
      var STATEMENT = /^(?:var|let|const|function|class|if|for|while|do|switch|try|throw|return|break|continue|export|debugger|with|import(?!\s*\()|async\s+function)\b/;
      var CONTINUES = /^(?:[.,?:=<>&|^%*/[(`]|\+(?!\+)|-(?!-)|!=|in\b|instanceof\b)/;
      for (var k = 0; k < candidates.length; k++) {
        var tail = body.slice(candidates[k].at, end);
        var lead = tail.replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/, "");
        if (!lead) continue;
        if (STATEMENT.test(lead)) break;
        if (candidates[k].kind !== "semicolon" && CONTINUES.test(lead)) continue;
        try { return new AsyncFunction(body.slice(0, candidates[k].at) + "\nreturn (" + tail + "\n);"); } catch (e) {}
      }
      try { return new AsyncFunction(body); } catch (e) { return null; }
    }

    function evaluate(p) {
      var code = p.expression == null ? "" : String(p.expression);
      var group = p.objectGroup;
      var compileError = null;
      // Compile without running: a dead branch parses the code like the real
      // evaluation does.
      try { (0, eval)("if (0) {\n" + code + "\n}"); } catch (e) { if (isSyntaxError(e)) compileError = e; }
      if (compileError) {
        var fn = p.replMode && /^await is only valid/.test(String(compileError.message)) ? replFunction(code) : null;
        if (!fn) return thrown(compileError, group, true);
        var promised;
        try { promised = fn(); } catch (e) { return thrown(e, group); }
        return p.awaitPromise ? settle(promised, p.returnByValue, group, true) : { result: remote(promised, false, group) };
      }
      var value;
      try { value = (0, eval)(code); } catch (e) { return thrown(e, group); }
      return settle(value, p.returnByValue, group, p.awaitPromise);
    }

    function object(id) {
      if (!reg.objects.has(id)) throw new Fail("Could not find object with given id");
      return reg.objects.get(id);
    }
    function argument(a) {
      if (!a || typeof a !== "object") return undefined;
      if (a.objectId) return object(a.objectId);
      if (typeof a.unserializableValue === "string") {
        var u = a.unserializableValue;
        if (/n$/.test(u)) return BigInt(u.slice(0, -1));
        return u === "-0" ? -0 : Number(u);
      }
      return a.value;
    }
    function callFunctionOn(p) {
      var group = p.objectGroup;
      var self = p.objectId ? object(p.objectId) : W;
      var args = (Array.isArray(p.arguments) ? p.arguments : []).map(argument);
      var fn;
      try { fn = (0, eval)("(" + String(p.functionDeclaration) + "\n)"); } catch (e) { return thrown(e, group, isSyntaxError(e)); }
      if (typeof fn !== "function") throw new Fail("Given expression does not evaluate to a function");
      var value;
      try { value = fn.apply(self, args); } catch (e) { return thrown(e, group); }
      return settle(value, p.returnByValue, group, p.awaitPromise);
    }
    function getProperties(p) {
      var obj = object(p.objectId);
      var result = [];
      var seen = new Set();
      var o = obj;
      var own = true;
      while (o !== null && o !== undefined && result.length < 1000) {
        var keys = [];
        try { keys = Object.getOwnPropertyNames(o).concat(Object.getOwnPropertySymbols(o)); } catch (e) {}
        for (var i = 0; i < keys.length && result.length < 1000; i++) {
          var k = keys[i];
          if (seen.has(k)) continue;
          seen.add(k);
          var desc;
          try { desc = Object.getOwnPropertyDescriptor(o, k); } catch (e) { continue; }
          if (!desc) continue;
          var entry = { name: String(typeof k === "symbol" ? k.toString() : k), configurable: !!desc.configurable, enumerable: !!desc.enumerable, isOwn: own };
          if ("value" in desc) {
            if (p.accessorPropertiesOnly) continue;
            entry.value = remote(desc.value, false, p.objectGroup);
            entry.writable = !!desc.writable;
          } else {
            entry.get = desc.get ? remote(desc.get, false, p.objectGroup) : { type: "undefined" };
            entry.set = desc.set ? remote(desc.set, false, p.objectGroup) : { type: "undefined" };
          }
          result.push(entry);
        }
        if (p.ownProperties) break;
        try { o = Object.getPrototypeOf(o); } catch (e) { o = null; }
        own = false;
      }
      return { result: result, internalProperties: [] };
    }

    // ── DOM ──
    function nodeId(n) {
      var id = reg.nodeIds.get(n);
      if (!id) {
        id = ++reg.seq;
        reg.nodeIds.set(n, id);
        reg.objects.set("node-" + id, n);
      }
      return id;
    }
    function nodeOf(p) {
      var n = null;
      if (p.nodeId != null) n = reg.objects.get("node-" + p.nodeId);
      else if (p.backendNodeId != null) n = reg.objects.get("node-" + p.backendNodeId);
      else if (p.objectId) n = reg.objects.get(p.objectId);
      if (!n || !isNode(n)) throw new Fail("Could not find node with given id");
      return n;
    }
    function nodeInfo(n, depth, budget) {
      var id = nodeId(n);
      var d = {
        nodeId: id, backendNodeId: id, nodeType: n.nodeType, nodeName: n.nodeName,
        localName: n.localName || "", nodeValue: n.nodeValue || "", childNodeCount: n.childNodes ? n.childNodes.length : 0,
      };
      if (n.nodeType === 1) {
        d.attributes = [];
        for (var i = 0; i < n.attributes.length; i++) d.attributes.push(n.attributes[i].name, n.attributes[i].value);
      }
      if (n.nodeType === 9) { d.documentURL = n.URL; d.baseURL = n.baseURI; d.xmlVersion = ""; }
      if (depth !== 0 && n.childNodes && budget.left > 0) {
        d.children = [];
        for (var c = n.firstChild; c && budget.left > 0; c = c.nextSibling) {
          budget.left--;
          d.children.push(nodeInfo(c, depth - 1, budget));
        }
      }
      return d;
    }
    function quad(r) { return [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom]; }
    function boxModel(el) {
      var r = el.getBoundingClientRect();
      var cs = W.getComputedStyle(el);
      var px = function (v) { return parseFloat(v) || 0; };
      var inset = function (rect, t, rt, b, l) {
        return { left: rect.left + l, top: rect.top + t, right: rect.right - rt, bottom: rect.bottom - b };
      };
      var border = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      var padding = inset(border, px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth));
      var content = inset(padding, px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft));
      var margin = inset(border, -px(cs.marginTop), -px(cs.marginRight), -px(cs.marginBottom), -px(cs.marginLeft));
      return { model: { content: quad(content), padding: quad(padding), border: quad(border), margin: quad(margin), width: r.width, height: r.height } };
    }
    function dom(method, q) {
      var root;
      switch (method) {
        case "getDocument":
          return { root: nodeInfo(W.document, q.depth === -1 ? 1000 : q.depth == null ? 1 : q.depth, { left: 5000 }) };
        case "describeNode":
          return { node: nodeInfo(nodeOf(q), q.depth === -1 ? 1000 : q.depth || 0, { left: 5000 }) };
        case "querySelector":
          root = nodeOf(q);
          var hit = root.querySelector(String(q.selector));
          return { nodeId: hit ? nodeId(hit) : 0 };
        case "querySelectorAll":
          root = nodeOf(q);
          return { nodeIds: Array.prototype.map.call(root.querySelectorAll(String(q.selector)), nodeId) };
        case "resolveNode":
          return { object: remote(nodeOf(q), false, q.objectGroup) };
        case "requestNode":
          return { nodeId: nodeId(nodeOf({ objectId: q.objectId })) };
        case "getBoxModel":
          return boxModel(nodeOf(q));
        case "getContentQuads":
          return { quads: Array.prototype.map.call(nodeOf(q).getClientRects(), quad) };
        case "scrollIntoViewIfNeeded":
          nodeOf(q).scrollIntoView({ block: "center", inline: "center" });
          return {};
        case "focus":
          nodeOf(q).focus();
          return {};
        case "getOuterHTML":
          return { outerHTML: nodeOf(q).outerHTML || "" };
        case "getAttributes":
          var el = nodeOf(q);
          var attrs = [];
          for (var i = 0; el.attributes && i < el.attributes.length; i++) attrs.push(el.attributes[i].name, el.attributes[i].value);
          return { attributes: attrs };
      }
      throw new Fail("'DOM." + method + "' wasn't found");
    }

    // A rough accessibility tree: roles from markup, names from labels and text.
    function axTree() {
      var ROLES = {
        button: "button", textarea: "textbox", select: "combobox", img: "image", ul: "list", ol: "list", li: "listitem",
        nav: "navigation", main: "main", header: "banner", footer: "contentinfo", form: "form", table: "table",
        tr: "row", td: "cell", th: "columnheader", p: "paragraph", dialog: "dialog", aside: "complementary",
        article: "article", option: "option", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
      };
      var INPUTS = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", range: "slider", search: "searchbox" };
      function role(el) {
        var explicit = el.getAttribute("role");
        if (explicit) return explicit.split(/\s+/)[0];
        var tag = el.localName;
        if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
        if (tag === "input") return INPUTS[(el.getAttribute("type") || "").toLowerCase()] || "textbox";
        return ROLES[tag] || "generic";
      }
      function name(el, r) {
        var v = el.getAttribute("aria-label");
        if (!v && el.getAttribute("aria-labelledby")) {
          v = el.getAttribute("aria-labelledby").split(/\s+/).map(function (id) {
            var t = W.document.getElementById(id);
            return t ? t.textContent : "";
          }).join(" ");
        }
        if (!v) v = el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || "";
        if (!v && el.labels && el.labels.length) v = el.labels[0].textContent;
        if (!v && /^(?:button|link|heading|option|cell|columnheader|listitem|tab|menuitem)$/.test(r)) v = el.textContent;
        return String(v || "").replace(/\s+/g, " ").trim().slice(0, 200);
      }
      var nodes = [];
      var budget = 4000;
      function walk(el, parentId) {
        if (budget-- <= 0) return null;
        var id = nodeId(el);
        var r = role(el);
        var node = { nodeId: String(id), ignored: false, role: { type: "role", value: r }, name: { type: "computedString", value: name(el, r) }, childIds: [], backendDOMNodeId: id };
        if (parentId) node.parentId = parentId;
        nodes.push(node);
        for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
          var child = walk(c, node.nodeId);
          if (child) node.childIds.push(child);
        }
        return node.nodeId;
      }
      if (W.document.documentElement) walk(W.document.documentElement, null);
      return { nodes: nodes };
    }

    // ── Hooks that report to the content-script relay ──
    function reporter() {
      if (reg.report) return reg.report;
      var queue = [];
      var timer = 0;
      function flush() {
        timer = 0;
        var batch = queue;
        queue = [];
        if (!batch.length) return;
        try { W.dispatchEvent(new CustomEvent(key, { detail: JSON.stringify(batch) })); } catch (e) {}
      }
      reg.report = function (item, now) {
        queue.push(item);
        if (now) flush();
        else if (!timer) timer = setTimeout(flush, 50);
      };
      return reg.report;
    }
    function hookDialogs() {
      if (reg.hooks.dialogs) return;
      var report = reporter();
      var text = function (v) { return v === undefined ? "" : String(v); };
      reg.hooks.dialogs = { alert: W.alert, confirm: W.confirm, prompt: W.prompt };
      W.alert = function alert(message) {
        report({ kind: "dialog", type: "alert", message: text(message), url: location.href }, true);
      };
      W.confirm = function confirm(message) {
        report({ kind: "dialog", type: "confirm", message: text(message), url: location.href }, true);
        return true;
      };
      W.prompt = function prompt(message, defaultValue) {
        var d = text(defaultValue);
        report({ kind: "dialog", type: "prompt", message: text(message), defaultPrompt: d, url: location.href }, true);
        return d;
      };
    }
    function consoleArg(v) {
      var t = typeof v;
      if (v === undefined) return { type: "undefined" };
      if (v === null) return { type: "object", subtype: "null", value: null };
      if (t === "string" || t === "boolean") return { type: t, value: v };
      if (t === "number") return isFinite(v) ? { type: "number", value: v, description: String(v) } : { type: "number", unserializableValue: String(v), description: String(v) };
      if (t === "bigint" || t === "symbol") return { type: t, description: String(v) + (t === "bigint" ? "n" : "") };
      if (t === "function") return { type: "function", className: "Function", description: String(v).slice(0, 500) };
      var sub = subtypeOf(v);
      var out = { type: "object", className: className(v), description: describe(v, sub) };
      if (sub) out.subtype = sub;
      return out;
    }
    function hookConsole() {
      if (reg.hooks.console) return;
      var report = reporter();
      var c = W.console;
      var TYPES = { warn: "warning", group: "startGroup", groupCollapsed: "startGroupCollapsed", groupEnd: "endGroup" };
      var originals = {};
      ["log", "info", "warn", "error", "debug", "dir", "dirxml", "table", "trace", "clear", "group", "groupCollapsed", "groupEnd", "assert", "count", "timeEnd"].forEach(function (m) {
        var f = c[m];
        if (typeof f !== "function") return;
        originals[m] = f;
        c[m] = function () {
          try {
            var args = Array.prototype.slice.call(arguments);
            if (m !== "assert" || !args[0]) {
              if (m === "assert") args = ["Assertion failed:"].concat(args.slice(1));
              report({ kind: "console", type: TYPES[m] || m, args: args.slice(0, 50).map(consoleArg), t: Date.now(), frames: frames(new Error().stack, 1) });
            }
          } catch (e) {}
          return f.apply(this, arguments);
        };
      });
      var onError = function (ev) {
        try {
          var e = ev.error;
          report({
            kind: "exception", t: Date.now(), text: "Uncaught", url: ev.filename || "",
            line: Math.max(0, (ev.lineno || 1) - 1), column: Math.max(0, (ev.colno || 1) - 1),
            className: isError(e) ? String(e.name) : "Error",
            description: isError(e) ? errorDescription(e, false) : String(ev.message || e),
            frames: isError(e) ? frames(e.stack) : [],
          });
        } catch (x) {}
      };
      var onRejection = function (ev) {
        try {
          var e = ev.reason;
          report({
            kind: "exception", t: Date.now(), text: "Uncaught (in promise)", url: "", line: 0, column: 0,
            className: isError(e) ? String(e.name) : className(e),
            description: isError(e) ? errorDescription(e, false) : String(e),
            frames: isError(e) ? frames(e.stack) : [],
          });
        } catch (x) {}
      };
      W.addEventListener("error", onError);
      W.addEventListener("unhandledrejection", onRejection);
      reg.hooks.console = { originals: originals, onError: onError, onRejection: onRejection };
    }
    function unhook(what) {
      var h = reg.hooks;
      if (h.console && what !== "dialogs") {
        Object.keys(h.console.originals).forEach(function (m) { W.console[m] = h.console.originals[m]; });
        W.removeEventListener("error", h.console.onError);
        W.removeEventListener("unhandledrejection", h.console.onRejection);
        h.console = null;
      }
      if (h.dialogs && what !== "console") {
        W.alert = h.dialogs.alert;
        W.confirm = h.dialogs.confirm;
        W.prompt = h.dialogs.prompt;
        h.dialogs = null;
      }
    }

    try {
      switch (op) {
        case "evaluate": return evaluate(p);
        case "callFunctionOn": return callFunctionOn(p);
        case "getProperties": return getProperties(p);
        case "awaitPromise": return settle(object(p.promiseObjectId), p.returnByValue, p.objectGroup, true);
        case "releaseObject": reg.objects.delete(p.objectId); return {};
        case "releaseObjectGroup":
          (reg.groups.get(p.objectGroup) || []).forEach(function (id) { reg.objects.delete(id); });
          reg.groups.delete(p.objectGroup);
          return {};
        case "dom": return dom(p.method, p.params || {});
        case "axTree": return axTree();
        case "hookDialogs": hookDialogs(); return true;
        case "hookConsole": hookConsole(); return true;
        case "unhook": unhook(p.what); return true;
      }
      return { __protocolError: "Unknown page operation " + op };
    } catch (e) {
      if (e instanceof Fail) return { __protocolError: e.message };
      throw e;
    }
  }

  // Runs in the content-script world: input, layout metrics, and the relay that
  // carries page reports to the background.
  function cdpIsolated(op, p) {
    var W = window;
    var D = document;
    var st = W.__cdpInputState || (W.__cdpInputState = { hover: null, down: null, mouseSuppressed: false, spaceTarget: null });
    var MODS = function (m) { return { altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8) }; };

    function shadowRoot(el) {
      try { return el.openOrClosedShadowRoot ? el.openOrClosedShadowRoot() : el.shadowRoot; } catch (e) { return null; }
    }
    function elementAt(x, y) {
      var el = D.elementFromPoint(x, y);
      for (var i = 0; el && i < 20; i++) {
        var root = shadowRoot(el);
        var inner = root && root.elementFromPoint ? root.elementFromPoint(x, y) : null;
        if (!inner || inner === el) break;
        el = inner;
      }
      return el;
    }
    function deepActive() {
      var el = D.activeElement;
      for (var i = 0; el && i < 20; i++) {
        var root = shadowRoot(el);
        if (!root || !root.activeElement) break;
        el = root.activeElement;
      }
      return el || D.body || D.documentElement;
    }
    // A point or the focus inside a frame continues in that frame; Firefox tells
    // a content script the frame ID of an <iframe> element.
    function childFrame(el, x, y) {
      if (!el || (el.localName !== "iframe" && el.localName !== "frame")) return null;
      var id = -1;
      try { id = browser.runtime.getFrameId(el); } catch (e) {}
      if (typeof id !== "number" || id < 0) return null;
      if (x === undefined) return { frameId: id };
      var r = el.getBoundingClientRect();
      var cs = W.getComputedStyle(el);
      return {
        frameId: id,
        x: x - r.left - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.paddingLeft) || 0),
        y: y - r.top - (parseFloat(cs.borderTopWidth) || 0) - (parseFloat(cs.paddingTop) || 0),
      };
    }
    function parentOf(n) { return n.parentNode || (n.host instanceof W.Element ? n.host : null); }
    function chain(n) {
      var out = [];
      for (; n && n.nodeType === 1; n = parentOf(n)) out.push(n);
      return out;
    }
    function fire(target, Ctor, type, init) {
      var ev;
      try { ev = new Ctor(type, init); } catch (e) {
        delete init.view;
        ev = new Ctor(type, init);
      }
      target.dispatchEvent(ev);
      return !ev.defaultPrevented;
    }
    function mouseInit(q, extra) {
      var init = {
        bubbles: true, cancelable: true, composed: true, view: W, detail: q.clickCount || 0,
        clientX: q.x, clientY: q.y, screenX: q.x + (W.mozInnerScreenX || 0), screenY: q.y + (W.mozInnerScreenY || 0),
        button: q.button < 0 ? 0 : q.button, buttons: q.buttons || 0,
      };
      var m = MODS(q.modifiers);
      for (var k in m) init[k] = m[k];
      for (var e in extra || {}) init[e] = extra[e];
      return init;
    }
    function pointer(target, type, q, extra) {
      var init = mouseInit(q, extra);
      init.pointerId = 1;
      init.pointerType = "mouse";
      init.isPrimary = true;
      init.width = 1;
      init.height = 1;
      init.pressure = init.buttons ? 0.5 : 0;
      if (typeof W.PointerEvent !== "function") return true;
      return fire(target, W.PointerEvent, type, init);
    }
    function hover(el, q) {
      var prev = st.hover && st.hover.isConnected ? st.hover : null;
      if (prev === el) return;
      var from = prev ? chain(prev) : [];
      var to = el ? chain(el) : [];
      if (prev) {
        pointer(prev, "pointerout", q, { relatedTarget: el });
        fire(prev, W.MouseEvent, "mouseout", mouseInit(q, { relatedTarget: el }));
        from.filter(function (n) { return to.indexOf(n) < 0; }).forEach(function (n) {
          pointer(n, "pointerleave", q, { bubbles: false, cancelable: false, relatedTarget: el });
          fire(n, W.MouseEvent, "mouseleave", mouseInit(q, { bubbles: false, cancelable: false, relatedTarget: el }));
        });
      }
      if (el) {
        pointer(el, "pointerover", q, { relatedTarget: prev });
        fire(el, W.MouseEvent, "mouseover", mouseInit(q, { relatedTarget: prev }));
        to.filter(function (n) { return from.indexOf(n) < 0; }).reverse().forEach(function (n) {
          pointer(n, "pointerenter", q, { bubbles: false, cancelable: false, relatedTarget: prev });
          fire(n, W.MouseEvent, "mouseenter", mouseInit(q, { bubbles: false, cancelable: false, relatedTarget: prev }));
        });
      }
      st.hover = el;
    }

    var TEXT_INPUT = /^(?:text|search|url|tel|email|password|number|)$/;
    function isTextField(el) {
      if (!el) return false;
      if (el.localName === "textarea") return true;
      return el.localName === "input" && TEXT_INPUT.test(String(el.type || "").toLowerCase());
    }
    function isEditable(el) { return !!el && (isTextField(el) || el.isContentEditable); }
    var FOCUSABLE = "a[href],area[href],button,input,select,textarea,iframe,summary,audio[controls],video[controls],[tabindex],[contenteditable]";
    function focusTarget(el) {
      for (var n = el; n && n.nodeType === 1; n = parentOf(n)) {
        if (n.isContentEditable && (!n.parentElement || !n.parentElement.isContentEditable)) return n;
        if (n.matches && n.matches(FOCUSABLE) && !n.disabled && n.getAttribute("contenteditable") !== "false") return n;
      }
      return null;
    }
    function selectWordAt(value, at) {
      var s = at;
      var e = at;
      while (s > 0 && /\w/.test(value.charAt(s - 1))) s--;
      while (e < value.length && /\w/.test(value.charAt(e))) e++;
      return [s, e];
    }
    function placeCaret(target, q) {
      var pos = null;
      try { pos = D.caretPositionFromPoint ? D.caretPositionFromPoint(q.x, q.y) : null; } catch (e) {}
      var count = q.clickCount || 1;
      if (isTextField(target)) {
        var value = String(target.value);
        var at = pos && pos.offsetNode === target ? pos.offset : value.length;
        try {
          if (count >= 3) target.select();
          else if (count === 2) { var w = selectWordAt(value, at); target.setSelectionRange(w[0], w[1]); }
          else target.setSelectionRange(at, at);
        } catch (e) {}
        return;
      }
      if (!pos || !pos.offsetNode || (count < 2 && !(target && target.isContentEditable))) return;
      var sel = W.getSelection();
      try {
        if (count >= 3) {
          var block = pos.offsetNode.nodeType === 1 ? pos.offsetNode : pos.offsetNode.parentElement;
          while (block && block !== D.body && /^(?:inline|contents)/.test(W.getComputedStyle(block).display)) block = block.parentElement;
          if (block) sel.selectAllChildren(block);
        } else {
          sel.collapse(pos.offsetNode, pos.offset);
          if (count === 2) { sel.modify("move", "backward", "word"); sel.modify("extend", "forward", "word"); }
        }
      } catch (e) {}
    }
    function linkOf(el) {
      for (var n = el; n && n.nodeType === 1; n = parentOf(n)) if ((n.localName === "a" || n.localName === "area") && n.href) return n;
      return null;
    }
    // A click on a link that opens a new tab would be stopped by the popup
    // blocker, so the background opens it instead.
    function interceptNewTab(q, middle) {
      var hit = null;
      var listener = function (ev) {
        if (ev.defaultPrevented) return;
        var a = linkOf(ev.target);
        if (!a || a.hasAttribute("download") || !/^(?:https?|ftp|data|blob|file):/i.test(a.href)) return;
        var newTab = middle || (q.modifiers & 6) || (a.target && !/^_(?:self|parent|top)$/i.test(a.target));
        if (!newTab) return;
        ev.preventDefault();
        hit = { url: a.href, active: !middle && !(q.modifiers & 6) };
      };
      W.addEventListener(middle ? "auxclick" : "click", listener);
      return function () {
        W.removeEventListener(middle ? "auxclick" : "click", listener);
        return hit;
      };
    }
    function scrollTarget(el, dx, dy) {
      for (var n = el; n && n !== D.body && n !== D.documentElement; n = parentOf(n)) {
        if (n.nodeType !== 1) continue;
        var cs = W.getComputedStyle(n);
        var canY = dy && /(?:auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight &&
          (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0);
        var canX = dx && /(?:auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth &&
          (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0);
        if (canY || canX) return n;
      }
      return null;
    }

    function mouse(q) {
      var el = elementAt(q.x, q.y);
      var frame = childFrame(el, q.x, q.y);
      if (frame) return { frame: frame };
      if (!el) return { hit: false };
      var bit = [1, 4, 2, 8, 16][q.button] || 0;
      if (q.type === "mouseMoved") {
        hover(el, q);
        if (pointer(el, "pointermove", q)) fire(el, W.MouseEvent, "mousemove", mouseInit(q));
        return { hit: true };
      }
      if (q.type === "mouseWheel") {
        hover(el, q);
        var init = mouseInit(q, { deltaX: q.deltaX, deltaY: q.deltaY, deltaZ: 0, deltaMode: 0 });
        if (fire(el, W.WheelEvent, "wheel", init)) {
          var box = scrollTarget(el, q.deltaX, q.deltaY);
          if (box) box.scrollBy(q.deltaX, q.deltaY);
          else W.scrollBy(q.deltaX, q.deltaY);
        }
        return { hit: true };
      }
      if (q.type === "mousePressed") {
        hover(el, q);
        q.buttons = (q.buttons || 0) | bit;
        st.mouseSuppressed = !pointer(el, "pointerdown", q);
        st.down = el;
        var proceed = st.mouseSuppressed || fire(el, W.MouseEvent, "mousedown", mouseInit(q));
        if (proceed && q.button === 0) {
          var target = focusTarget(el);
          if (target) { if (deepActive() !== target) target.focus(); }
          else {
            var active = deepActive();
            if (active && active !== D.body && active.blur) active.blur();
          }
          placeCaret(target || el, q);
        }
        if (q.button === 2) fire(el, W.MouseEvent, "contextmenu", mouseInit(q));
        return { hit: true };
      }
      if (q.type === "mouseReleased") {
        q.buttons = (q.buttons || 0) & ~bit;
        pointer(el, "pointerup", q);
        if (!st.mouseSuppressed) fire(el, W.MouseEvent, "mouseup", mouseInit(q));
        var down = st.down && st.down.isConnected ? st.down : null;
        st.down = null;
        st.mouseSuppressed = false;
        if (!down) return { hit: true };
        var common = down;
        while (common && !(common === el || (common.contains && common.contains(el)))) common = parentOf(common);
        if (!common) return { hit: true };
        var middle = q.button !== 0;
        var done = interceptNewTab(q, middle && q.button === 1);
        if (!middle) {
          fire(common, W.MouseEvent, "click", mouseInit(q));
          if ((q.clickCount || 1) === 2) fire(common, W.MouseEvent, "dblclick", mouseInit(q));
        } else {
          pointer(common, "auxclick", q);
        }
        var open = done();
        return open ? { hit: true, open: open } : { hit: true };
      }
      return { hit: false };
    }

    // ── Keys ──
    function nativeSetValue(el, value) {
      var proto = el.localName === "textarea" ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    }
    function selection(el) {
      try {
        var s = el.selectionStart;
        var e = el.selectionEnd;
        if (typeof s === "number" && typeof e === "number") return [s, e];
      } catch (x) {}
      var len = String(el.value).length;
      return [len, len];
    }
    // Replace the field's selection the way typing does, firing beforeinput and
    // input. execCommand goes through Firefox's editor, so frameworks see a
    // normal edit and undo works; the value setter is the fallback.
    function replaceInField(el, text, inputType) {
      var ok = false;
      try {
        if (inputType === "insertText" || inputType === "insertLineBreak") ok = D.execCommand("insertText", false, text);
        else if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") {
          ok = D.execCommand(inputType === "deleteContentBackward" ? "delete" : "forwardDelete", false, null);
        }
      } catch (e) {}
      if (ok) return true;
      var sel = selection(el);
      var value = String(el.value);
      var s = sel[0];
      var e2 = sel[1];
      if (s === e2 && inputType === "deleteContentBackward") s = Math.max(0, s - 1);
      if (s === e2 && inputType === "deleteContentForward") e2 = Math.min(value.length, e2 + 1);
      if (!fire(el, W.InputEvent, "beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: inputType, data: text || null })) return false;
      nativeSetValue(el, value.slice(0, s) + (text || "") + value.slice(e2));
      try { el.setSelectionRange(s + (text || "").length, s + (text || "").length); } catch (x) {}
      fire(el, W.InputEvent, "input", { bubbles: true, cancelable: false, composed: true, inputType: inputType, data: text || null });
      return true;
    }
    function insertText(text) {
      var el = deepActive();
      if (isTextField(el)) return replaceInField(el, text, "insertText");
      if (el && el.isContentEditable) {
        try { if (D.execCommand("insertText", false, text)) return true; } catch (e) {}
      }
      return false;
    }
    function moveInField(el, cmd, extend) {
      var value = String(el.value);
      var sel = selection(el);
      var dir = "none";
      try { dir = el.selectionDirection || "none"; } catch (e) {}
      var focus = dir === "backward" ? sel[0] : sel[1];
      var anchor = dir === "backward" ? sel[1] : sel[0];
      var lineStart = value.lastIndexOf("\n", focus - 1) + 1;
      var lineEnd = value.indexOf("\n", focus);
      if (lineEnd < 0) lineEnd = value.length;
      var to = focus;
      if (cmd === "left") to = !extend && sel[0] !== sel[1] ? sel[0] : Math.max(0, focus - 1);
      else if (cmd === "right") to = !extend && sel[0] !== sel[1] ? sel[1] : Math.min(value.length, focus + 1);
      else if (cmd === "wordLeft") { to = focus; while (to > 0 && !/\w/.test(value.charAt(to - 1))) to--; while (to > 0 && /\w/.test(value.charAt(to - 1))) to--; }
      else if (cmd === "wordRight") { to = focus; while (to < value.length && !/\w/.test(value.charAt(to))) to++; while (to < value.length && /\w/.test(value.charAt(to))) to++; }
      else if (cmd === "lineStart") to = lineStart;
      else if (cmd === "lineEnd") to = lineEnd;
      else if (cmd === "docStart") to = 0;
      else if (cmd === "docEnd") to = value.length;
      else if (cmd === "up" || cmd === "down") {
        if (el.localName !== "textarea") to = cmd === "up" ? 0 : value.length;
        else {
          var col = focus - lineStart;
          if (cmd === "up") {
            if (lineStart === 0) to = 0;
            else { var prevStart = value.lastIndexOf("\n", lineStart - 2) + 1; to = Math.min(prevStart + col, lineStart - 1); }
          } else if (lineEnd === value.length) to = value.length;
          else { var nextEnd = value.indexOf("\n", lineEnd + 1); if (nextEnd < 0) nextEnd = value.length; to = Math.min(lineEnd + 1 + col, nextEnd); }
        }
      }
      try {
        if (extend) {
          if (to < anchor) el.setSelectionRange(to, anchor, "backward");
          else el.setSelectionRange(anchor, to, "forward");
        } else el.setSelectionRange(to, to);
      } catch (e) {}
    }
    var GRANULARITY = { left: ["backward", "character"], right: ["forward", "character"], wordLeft: ["backward", "word"], wordRight: ["forward", "word"], lineStart: ["backward", "lineboundary"], lineEnd: ["forward", "lineboundary"], up: ["backward", "line"], down: ["forward", "line"] };
    function scrollPage(dx, dy) { W.scrollBy(dx, dy); }
    // Editing commands, named like macOS's (which clients send in `commands`).
    function command(name, el) {
      var extend = /AndModifySelection$/.test(name);
      var base = name.replace(/AndModifySelection$/, "");
      var MOVES = {
        moveLeft: "left", moveBackward: "left", moveRight: "right", moveForward: "right",
        moveWordLeft: "wordLeft", moveWordBackward: "wordLeft", moveWordRight: "wordRight", moveWordForward: "wordRight",
        moveToLeftEndOfLine: "lineStart", moveToBeginningOfLine: "lineStart", moveToBeginningOfParagraph: "lineStart",
        moveToRightEndOfLine: "lineEnd", moveToEndOfLine: "lineEnd", moveToEndOfParagraph: "lineEnd",
        moveUp: "up", moveDown: "down", moveToBeginningOfDocument: "docStart", moveToEndOfDocument: "docEnd",
      };
      var DELETES = {
        deleteBackward: ["deleteContentBackward", "left"], deleteForward: ["deleteContentForward", "right"],
        deleteWordBackward: ["deleteContentBackward", "wordLeft"], deleteWordForward: ["deleteContentForward", "wordRight"],
        deleteToBeginningOfLine: ["deleteContentBackward", "lineStart"], deleteToEndOfParagraph: ["deleteContentForward", "lineEnd"],
        deleteToEndOfLine: ["deleteContentForward", "lineEnd"], deleteBackwardByDecomposingPreviousCharacter: ["deleteContentBackward", "left"],
      };
      if (base === "selectAll") {
        if (isTextField(el)) el.select();
        else if (el && el.isContentEditable) W.getSelection().selectAllChildren(el);
        else W.getSelection().selectAllChildren(D.body || D.documentElement);
        return true;
      }
      if (base === "undo" || base === "redo" || base === "copy" || base === "cut" || base === "paste") {
        try { D.execCommand(base, false, null); } catch (e) {}
        return true;
      }
      if (MOVES[base]) {
        var move = MOVES[base];
        if (isTextField(el)) moveInField(el, move, extend);
        else if (el && el.isContentEditable) {
          if (move === "docStart" || move === "docEnd") {
            var r = D.createRange();
            r.selectNodeContents(el);
            r.collapse(move === "docStart");
            var s = W.getSelection();
            if (extend) s.extend(r.startContainer, r.startOffset);
            else { s.removeAllRanges(); s.addRange(r); }
          } else W.getSelection().modify(extend ? "extend" : "move", GRANULARITY[move][0], GRANULARITY[move][1]);
        } else if (move === "up" || move === "down") scrollPage(0, move === "up" ? -40 : 40);
        else if (move === "left" || move === "right") scrollPage(move === "left" ? -40 : 40, 0);
        else if (move === "docStart" || move === "docEnd") W.scrollTo(W.scrollX, move === "docStart" ? 0 : D.documentElement.scrollHeight);
        return true;
      }
      if (DELETES[base]) {
        var del = DELETES[base];
        if (isTextField(el)) {
          var sel = selection(el);
          if (sel[0] === sel[1] && del[1] !== "left" && del[1] !== "right") moveInField(el, del[1], true);
          replaceInField(el, "", del[0]);
        } else if (el && el.isContentEditable) {
          var ws = W.getSelection();
          if (ws.isCollapsed && del[1] !== "left" && del[1] !== "right") ws.modify("extend", GRANULARITY[del[1]][0], GRANULARITY[del[1]][1]);
          try { D.execCommand(del[0] === "deleteContentBackward" ? "delete" : "forwardDelete", false, null); } catch (e) {}
        }
        return true;
      }
      if (base === "insertNewline" || base === "insertLineBreak" || base === "insertNewlineIgnoringFieldEditor" || base === "insertParagraph") {
        if (el && el.localName === "textarea") replaceInField(el, "\n", "insertLineBreak");
        else if (el && el.isContentEditable) {
          try { D.execCommand(base === "insertLineBreak" ? "insertLineBreak" : "insertParagraph", false, null); } catch (e) {}
        } else if (el && el.localName === "input" && /^(?:submit|reset|button|image)$/.test(String(el.type).toLowerCase())) el.click();
        else if (el && el.localName === "input") submitImplicitly(el);
        else if (el && (el.localName === "a" || el.localName === "button" || el.localName === "summary")) el.click();
        return true;
      }
      if (base === "scrollPageUp" || base === "pageUp") { scrollPage(0, -W.innerHeight * 0.875); return true; }
      if (base === "scrollPageDown" || base === "pageDown") { scrollPage(0, W.innerHeight * 0.875); return true; }
      if (base === "scrollToBeginningOfDocument") { W.scrollTo(W.scrollX, 0); return true; }
      if (base === "scrollToEndOfDocument") { W.scrollTo(W.scrollX, D.documentElement.scrollHeight); return true; }
      return false;
    }
    // Enter in a text field submits its form: through the form's default button
    // when it has one, else directly when the field is the only text field.
    function submitImplicitly(el) {
      var form = el.form;
      if (!form) return;
      var buttons = form.querySelectorAll("button, input[type=submit], input[type=image]");
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var type = String(b.getAttribute("type") || (b.localName === "button" ? "submit" : "")).toLowerCase();
        if ((type === "submit" || type === "image") && b.form === form) {
          if (!b.disabled) b.click();
          return;
        }
      }
      var fields = Array.prototype.filter.call(form.elements, function (f) { return isTextField(f) && f.localName === "input"; });
      if (fields.length === 1) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      }
    }
    function focusables() {
      var all = Array.prototype.filter.call(D.querySelectorAll(FOCUSABLE), function (el) {
        if (el.disabled || el.tabIndex < 0 || el.getAttribute("contenteditable") === "false") return false;
        if (el.localName === "input" && String(el.type).toLowerCase() === "hidden") return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      });
      var positive = all.filter(function (el) { return el.tabIndex > 0; }).sort(function (a, b) { return a.tabIndex - b.tabIndex; });
      return positive.concat(all.filter(function (el) { return el.tabIndex === 0; }));
    }
    function moveFocus(el, back) {
      var list = focusables();
      if (!list.length) return;
      var i = list.indexOf(el);
      var next = back ? list[(i <= 0 ? list.length : i) - 1] : list[(i + 1) % list.length];
      next.focus();
      if (isTextField(next)) { try { next.select(); } catch (e) {} }
    }
    function defaultCommand(key, mods, el) {
      var shift = mods & 8;
      var word = mods & 1 || (mods & 2 && !(mods & 4));
      var line = mods & 4;
      var sel = shift ? "AndModifySelection" : "";
      var lower = key.length === 1 ? key.toLowerCase() : key;
      if (mods & 6 && lower === "a") return "selectAll";
      if (mods & 6 && lower === "z") return shift ? "redo" : "undo";
      if (mods & 6 && lower === "y") return "redo";
      if (mods & 6 && (lower === "c" || lower === "x" || lower === "v")) return { c: "copy", x: "cut", v: "paste" }[lower];
      switch (key) {
        case "Backspace": return line ? "deleteToBeginningOfLine" : word ? "deleteWordBackward" : "deleteBackward";
        case "Delete": return word ? "deleteWordForward" : "deleteForward";
        case "Enter": return shift ? "insertLineBreak" : "insertNewline";
        case "ArrowLeft": return (line ? "moveToLeftEndOfLine" : word ? "moveWordLeft" : "moveLeft") + sel;
        case "ArrowRight": return (line ? "moveToRightEndOfLine" : word ? "moveWordRight" : "moveRight") + sel;
        case "ArrowUp": return (line ? "moveToBeginningOfDocument" : "moveUp") + sel;
        case "ArrowDown": return (line ? "moveToEndOfDocument" : "moveDown") + sel;
        case "Home": return isEditable(el) ? (mods & 2 ? "moveToBeginningOfDocument" : "moveToBeginningOfLine") + sel : "scrollToBeginningOfDocument";
        case "End": return isEditable(el) ? (mods & 2 ? "moveToEndOfDocument" : "moveToEndOfLine") + sel : "scrollToEndOfDocument";
        case "PageUp": return "scrollPageUp";
        case "PageDown": return "scrollPageDown";
      }
      return "";
    }
    function changeSelect(el, delta) {
      var i = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + delta));
      if (i === el.selectedIndex) return;
      el.selectedIndex = i;
      fire(el, W.Event, "input", { bubbles: true, composed: true });
      fire(el, W.Event, "change", { bubbles: true });
    }
    function key(q) {
      var el = deepActive();
      var frame = childFrame(el);
      if (frame) return { frame: frame };
      var mods = q.modifiers | 0;
      var init = {
        key: q.key || "", code: q.code || "", location: q.location || 0, repeat: !!q.autoRepeat,
        keyCode: q.keyCode || 0, which: q.keyCode || 0, charCode: 0,
        bubbles: true, cancelable: true, composed: true, view: W,
      };
      var m = MODS(mods);
      for (var k in m) init[k] = m[k];
      var text = typeof q.text === "string" ? q.text : "";
      if (q.type === "keyUp") {
        var activate = st.spaceTarget;
        st.spaceTarget = null;
        if (fire(el, W.KeyboardEvent, "keyup", init) && activate === el && q.key === " ") el.click();
        return { ok: true };
      }
      if (q.type === "char") {
        if (text && fire(el, W.KeyboardEvent, "keypress", Object.assign({}, init, { charCode: text.charCodeAt(0), keyCode: 0, which: text.charCodeAt(0) }))) {
          if (text !== "\r" && text !== "\n") insertText(text);
        }
        return { ok: true };
      }
      if (!fire(el, W.KeyboardEvent, "keydown", init)) return { prevented: true };
      var printable = q.type === "keyDown" && text && !(mods & 6);
      if (printable) {
        var code = text.charCodeAt(0);
        if (!fire(el, W.KeyboardEvent, "keypress", Object.assign({}, init, { charCode: code, keyCode: q.key === "Enter" ? code : 0, which: code }))) return { prevented: true };
      }
      var commands = Array.isArray(q.commands) ? q.commands.filter(function (c) { return typeof c === "string"; }) : [];
      if (commands.length) {
        commands.forEach(function (c) { command(c, deepActive()); });
        return { ok: true };
      }
      if (q.key === "Tab" && !(mods & 7)) { moveFocus(el, !!(mods & 8)); return { ok: true }; }
      if (q.key === " " && !isEditable(el)) {
        var type = el && el.localName === "input" ? String(el.type).toLowerCase() : "";
        if (el && (el.localName === "button" || el.localName === "summary" || /^(?:checkbox|radio|button|submit|reset|image)$/.test(type))) st.spaceTarget = el;
        else scrollPage(0, (mods & 8 ? -1 : 1) * W.innerHeight * 0.875);
        return { ok: true };
      }
      if (el && el.localName === "select" && (q.key === "ArrowUp" || q.key === "ArrowDown")) {
        changeSelect(el, q.key === "ArrowUp" ? -1 : 1);
        return { ok: true };
      }
      if (printable && q.key !== "Enter") { insertText(text); return { ok: true }; }
      var name = defaultCommand(q.key || "", mods, el);
      if (name) command(name, el);
      return { ok: true };
    }

    switch (op) {
      case "metrics":
        var de = D.documentElement || {};
        var body = D.body || {};
        var vv = W.visualViewport;
        return {
          dpr: W.devicePixelRatio || 1, iw: W.innerWidth, ih: W.innerHeight, cw: de.clientWidth || W.innerWidth, ch: de.clientHeight || W.innerHeight,
          sx: W.scrollX, sy: W.scrollY, sw: Math.max(de.scrollWidth || 0, body.scrollWidth || 0), sh: Math.max(de.scrollHeight || 0, body.scrollHeight || 0),
          vv: vv ? { x: vv.offsetLeft, y: vv.offsetTop, px: vv.pageLeft, py: vv.pageTop, w: vv.width, h: vv.height, s: vv.scale } : null,
        };
      case "mouse": return mouse(p);
      case "key": return key(p);
      case "insertText":
        var target = deepActive();
        var frame = childFrame(target);
        if (frame) return { frame: frame };
        return { inserted: insertText(String(p.text)) };
      case "relay":
        var flag = "__cdpRelay_" + p.key;
        if (W[flag]) return true;
        W[flag] = true;
        W.addEventListener(p.key, function (ev) {
          var batch;
          try { batch = JSON.parse(String(ev.detail)); } catch (e) { return; }
          if (!Array.isArray(batch) || !batch.length) return;
          var msg = { reports: batch };
          msg[p.msgKey] = "report";
          try { browser.runtime.sendMessage(msg).catch(function () {}); } catch (e) {}
        });
        return true;
    }
    return null;
  }

  // ── Background: the sessions ──
  function debuggerHost() {
    var sessions = {};
    var evt = makeEvent();
    var det = makeEvent();
    var channel = null;
    try { channel = new BroadcastChannel(CDP_KEY); } catch (e) {}
    var keepAlive = null;
    var lifecycleHooked = false;
    var networkHooked = false;
    var requests = {};
    var commitWaiters = {};
    var session = null;
    try { session = api.storage && api.storage.session; } catch (e) {}

    function post(message) {
      try { if (channel) channel.postMessage(message); } catch (e) {}
    }
    function emit(tabId, method, params) {
      if (!sessions[tabId]) return;
      var source = { tabId: tabId };
      evt.dispatch(source, method, params);
      post({ kind: "event", source: source, method: method, params: params });
    }
    function persist() {
      if (!session) return;
      var o = {};
      o[CDP_STATE_KEY] = sessions;
      Promise.resolve(session.set(o)).catch(noop);
    }
    function updateKeepAlive() {
      var any = Object.keys(sessions).length > 0;
      // Firefox suspends an idle event page after 30 s; a call into the
      // extension API resets that timer, and a session must outlive it.
      if (any && keepAlive === null) {
        keepAlive = setInterval(function () {
          try { Promise.resolve(api.runtime.getPlatformInfo()).catch(noop); } catch (e) {}
        }, CDP_KEEPALIVE_MS);
      } else if (!any && keepAlive !== null) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    }
    function ended(tabId, reason) {
      if (!sessions[tabId]) return;
      delete sessions[tabId];
      persist();
      updateKeepAlive();
      if (!anyNetwork()) hookNetwork(false);
      if (!reason) return;
      var source = { tabId: tabId };
      det.dispatch(source, reason);
      post({ kind: "detach", source: source, reason: reason });
    }

    function noSuchTab(tabId) { return new Error("No tab with given id " + tabId + "."); }
    function getTab(tabId) {
      return Promise.resolve(api.tabs.get(tabId)).then(function (tab) {
        if (!tab) throw noSuchTab(tabId);
        return tab;
      }, function () { throw noSuchTab(tabId); });
    }
    function exec(tabId, frameId, world, func, args, allFrames) {
      if (!api.scripting || typeof api.scripting.executeScript !== "function") {
        return Promise.reject(protocolError("The add-on lacks the scripting permission"));
      }
      var target = allFrames ? { tabId: tabId, allFrames: true } : { tabId: tabId, frameIds: [frameId || 0] };
      var details = { target: target, func: func, args: args, injectImmediately: true };
      if (world === "MAIN") details.world = "MAIN";
      return Promise.resolve(api.scripting.executeScript(details)).then(function (results) {
        if (allFrames) return results;
        var r = results && results[0];
        if (!r) throw protocolError("Cannot find default execution context");
        if (r.error !== undefined && r.error !== null) throw protocolError(errorMessage(r.error));
        var value = r.result;
        if (value && typeof value === "object" && typeof value.__protocolError === "string") throw protocolError(value.__protocolError);
        return value;
      }, function (err) {
        return Promise.resolve(api.tabs.get(tabId)).then(function () {
          throw protocolError(errorMessage(err));
        }, function () { throw noSuchTab(tabId); });
      });
    }
    function main(tabId, op, params, frameId) {
      return exec(tabId, frameId || 0, "MAIN", cdpMain, [op, params || {}, CDP_PAGE_KEY]);
    }
    function isolated(tabId, op, params, frameId) {
      return exec(tabId, frameId || 0, "ISOLATED", cdpIsolated, [op, params || {}]);
    }
    // Follow a point or the focus into child frames, one hop per call.
    function inFrames(tabId, op, params, frameId, depth) {
      return isolated(tabId, op, params, frameId).then(function (r) {
        if (r && r.frame && (depth || 0) < 10) {
          var next = Object.assign({}, params);
          if (typeof r.frame.x === "number") { next.x = r.frame.x; next.y = r.frame.y; }
          return inFrames(tabId, op, next, r.frame.frameId, (depth || 0) + 1);
        }
        return r;
      });
    }
    // A frame Firefox won't script fails the whole all-frames injection; the
    // top frame alone is still worth reaching then.
    function everyFrame(tabId, world, func, args) {
      return exec(tabId, 0, world, func, args, true).catch(function () { return exec(tabId, 0, world, func, args); });
    }
    // The relay and the dialog hook go into every frame of the tab; the console
    // hook into the top frame, while Runtime is enabled.
    function hookPage(tabId, frameId) {
      var s = sessions[tabId];
      if (!s) return Promise.resolve();
      var all = frameId === undefined;
      var relay = { key: CDP_PAGE_KEY, msgKey: CDP_KEY };
      var target = function (func, args, world) {
        return all ? everyFrame(tabId, world, func, args) : exec(tabId, frameId, world, func, args);
      };
      return target(cdpIsolated, ["relay", relay], "ISOLATED").then(function () {
        return target(cdpMain, ["hookDialogs", {}, CDP_PAGE_KEY], "MAIN");
      }).then(function () {
        if (s.runtime && (all || frameId === 0)) return main(tabId, "hookConsole", {});
        return undefined;
      }).catch(noop);
    }
    function executionContext(tabId) {
      return getTab(tabId).then(function (tab) {
        var origin = "";
        try { origin = new URL(tab.url).origin; } catch (e) {}
        emit(tabId, "Runtime.executionContextCreated", {
          context: { id: 1, origin: origin, name: "", uniqueId: tabId + ".1", auxData: { isDefault: true, type: "default", frameId: String(tabId) } },
        });
      }).catch(noop);
    }

    function hookLifecycle() {
      if (lifecycleHooked) return;
      lifecycleHooked = true;
      var tabs = api.tabs;
      if (tabs.onRemoved) tabs.onRemoved.addListener(function (tabId) { ended(tabId, "target_closed"); });
      if (tabs.onUpdated) {
        tabs.onUpdated.addListener(function (tabId, change) {
          if (sessions[tabId] && change && change.url && cdpRestricted(change.url)) ended(tabId, "target_closed");
        });
      }
      var nav = api.webNavigation;
      if (!nav) return;
      var ts = function (d) { return (d && d.timeStamp ? d.timeStamp : Date.now()) / 1000; };
      var pageOn = function (d) { var s = sessions[d.tabId]; return s && s.page; };
      nav.onBeforeNavigate.addListener(function (d) {
        if (d.frameId === 0 && pageOn(d)) emit(d.tabId, "Page.frameStartedLoading", { frameId: String(d.tabId) });
      });
      nav.onCommitted.addListener(function (d) {
        var s = sessions[d.tabId];
        if (!s) return;
        if (d.frameId === 0) {
          var waiter = commitWaiters[d.tabId];
          if (waiter) waiter(null);
          if (cdpRestricted(d.url)) { ended(d.tabId, "target_closed"); return; }
        }
        if (s.page) {
          var origin = "";
          try { origin = new URL(d.url).origin; } catch (e) {}
          var frame = { id: cdpFrameId(d.tabId, d.frameId), loaderId: d.tabId + "-" + Math.floor(d.timeStamp || Date.now()), url: d.url, domainAndRegistry: "", securityOrigin: origin, mimeType: "text/html", secureContextType: /^https:/.test(d.url) ? "Secure" : "InsecureScheme", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] };
          if (d.frameId !== 0) frame.parentId = cdpFrameId(d.tabId, d.parentFrameId > 0 ? d.parentFrameId : 0);
          emit(d.tabId, "Page.frameNavigated", { frame: frame, type: "Navigation" });
        }
        if (d.frameId === 0 && s.runtime) {
          emit(d.tabId, "Runtime.executionContextsCleared", {});
          executionContext(d.tabId);
        }
        hookPage(d.tabId, d.frameId);
      });
      nav.onDOMContentLoaded.addListener(function (d) {
        if (d.frameId !== 0 || !pageOn(d)) return;
        emit(d.tabId, "Page.domContentEventFired", { timestamp: ts(d) });
        emit(d.tabId, "Page.lifecycleEvent", { frameId: String(d.tabId), loaderId: String(d.tabId), name: "DOMContentLoaded", timestamp: ts(d) });
      });
      nav.onCompleted.addListener(function (d) {
        if (d.frameId !== 0 || !pageOn(d)) return;
        emit(d.tabId, "Page.loadEventFired", { timestamp: ts(d) });
        emit(d.tabId, "Page.lifecycleEvent", { frameId: String(d.tabId), loaderId: String(d.tabId), name: "load", timestamp: ts(d) });
        emit(d.tabId, "Page.frameStoppedLoading", { frameId: String(d.tabId) });
      });
      nav.onErrorOccurred.addListener(function (d) {
        if (d.frameId !== 0) return;
        var waiter = commitWaiters[d.tabId];
        if (waiter) waiter(d.error || "Navigation failed");
        if (pageOn(d)) emit(d.tabId, "Page.frameStoppedLoading", { frameId: String(d.tabId) });
      });
      // A fragment or history navigation never commits; it answers a
      // Page.navigate to that URL.
      var sameDocument = function (type) {
        return function (d) {
          if (d.frameId !== 0) return;
          var waiter = commitWaiters[d.tabId];
          if (waiter && waiter.url === d.url) waiter(null, true);
          if (pageOn(d)) emit(d.tabId, "Page.navigatedWithinDocument", { frameId: String(d.tabId), url: d.url, navigationType: type });
        };
      };
      if (nav.onHistoryStateUpdated) nav.onHistoryStateUpdated.addListener(sameDocument("historyApi"));
      if (nav.onReferenceFragmentUpdated) nav.onReferenceFragmentUpdated.addListener(sameDocument("fragment"));
    }

    // ── Network, from webRequest ──
    function headerMap(list) {
      var out = {};
      (list || []).forEach(function (h) {
        if (!h || !h.name) return;
        var v = h.value !== undefined ? String(h.value) : "";
        out[h.name] = out[h.name] !== undefined ? out[h.name] + "\n" + v : v;
      });
      return out;
    }
    function statusText(line, code) {
      var m = /^\S+\s+\d+\s*(.*)$/.exec(String(line || ""));
      return m ? m[1] : String(code || "");
    }
    function postData(body, max) {
      if (!body) return "";
      var text = "";
      try {
        if (body.formData) {
          text = Object.keys(body.formData).map(function (k) {
            return [].concat(body.formData[k]).map(function (v) { return encodeURIComponent(k) + "=" + encodeURIComponent(v); }).join("&");
          }).join("&");
        } else if (body.raw) {
          var decoder = new TextDecoder();
          text = body.raw.map(function (part) { return part.bytes ? decoder.decode(part.bytes) : ""; }).join("");
        }
      } catch (e) {}
      return max > 0 && text.length > max ? text.slice(0, max) : text;
    }
    function networkFor(d) {
      var s = sessions[d.tabId];
      return s && s.network ? s : null;
    }
    var net = {
      before: function (d) {
        var s = networkFor(d);
        if (!s) return;
        var prev = requests[d.requestId];
        var type = CDP_RESOURCE_TYPES[d.type] || "Other";
        var request = { url: d.url, method: d.method, headers: {}, initialPriority: "Medium", referrerPolicy: "strict-origin-when-cross-origin" };
        var data = postData(d.requestBody, s.maxPostDataSize || 0);
        if (data) { request.postData = data; request.hasPostData = true; }
        var params = {
          requestId: String(d.requestId), loaderId: String(d.tabId), documentURL: d.documentUrl || d.url, request: request,
          timestamp: d.timeStamp / 1000, wallTime: d.timeStamp / 1000,
          initiator: d.originUrl ? { type: "script", url: d.originUrl } : { type: "other" },
          redirectHasExtraInfo: false, type: type, frameId: cdpFrameId(d.tabId, d.frameId), hasUserGesture: false,
        };
        if (prev && prev.redirect) params.redirectResponse = prev.redirect;
        requests[d.requestId] = { type: type };
        emit(d.tabId, "Network.requestWillBeSent", params);
      },
      headers: function (d) {
        if (!networkFor(d) || !requests[d.requestId]) return;
        emit(d.tabId, "Network.requestWillBeSentExtraInfo", { requestId: String(d.requestId), associatedCookies: [], headers: headerMap(d.requestHeaders), connectTiming: { requestTime: d.timeStamp / 1000 } });
      },
      redirect: function (d) {
        var r = requests[d.requestId];
        if (!networkFor(d) || !r) return;
        r.redirect = { url: d.url, status: d.statusCode, statusText: statusText(d.statusLine, d.statusCode), headers: headerMap(d.responseHeaders), mimeType: "", connectionReused: false, connectionId: 0, encodedDataLength: 0, securityState: "unknown" };
      },
      response: function (d) {
        var r = requests[d.requestId];
        if (!networkFor(d) || !r) return;
        var headers = headerMap(d.responseHeaders);
        var mime = "";
        Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === "content-type") mime = headers[k].split(";")[0].trim(); });
        var protocol = /^HTTP\/2/i.test(d.statusLine || "") ? "h2" : /^HTTP\/3/i.test(d.statusLine || "") ? "h3" : "http/1.1";
        emit(d.tabId, "Network.responseReceived", {
          requestId: String(d.requestId), loaderId: String(d.tabId), timestamp: d.timeStamp / 1000, type: r.type, hasExtraInfo: false,
          frameId: cdpFrameId(d.tabId, d.frameId),
          response: {
            url: d.url, status: d.statusCode, statusText: statusText(d.statusLine, d.statusCode), headers: headers, mimeType: mime,
            connectionReused: false, connectionId: 0, remoteIPAddress: d.ip || "", remotePort: 0, fromDiskCache: !!d.fromCache,
            fromServiceWorker: false, fromPrefetchCache: false, encodedDataLength: 0, protocol: protocol,
            securityState: /^https:/.test(d.url) ? "secure" : "neutral",
          },
        });
      },
      completed: function (d) {
        var r = requests[d.requestId];
        delete requests[d.requestId];
        if (!networkFor(d) || !r) return;
        emit(d.tabId, "Network.loadingFinished", { requestId: String(d.requestId), timestamp: d.timeStamp / 1000, encodedDataLength: d.responseSize || 0 });
      },
      failed: function (d) {
        var r = requests[d.requestId];
        delete requests[d.requestId];
        if (!networkFor(d) || !r) return;
        emit(d.tabId, "Network.loadingFailed", { requestId: String(d.requestId), timestamp: d.timeStamp / 1000, type: r.type, errorText: String(d.error || ""), canceled: /ABORT/i.test(String(d.error || "")) });
      },
    };
    function hookNetwork(on) {
      var wr = api.webRequest;
      if (!wr || networkHooked === on) return;
      networkHooked = on;
      // Requests still in flight would never hear their end.
      if (!on) requests = {};
      var filter = { urls: ["<all_urls>"] };
      var pairs = [
        ["onBeforeRequest", net.before, ["requestBody"]], ["onSendHeaders", net.headers, ["requestHeaders"]],
        ["onBeforeRedirect", net.redirect, ["responseHeaders"]], ["onResponseStarted", net.response, ["responseHeaders"]],
        ["onCompleted", net.completed, []], ["onErrorOccurred", net.failed, null],
      ];
      pairs.forEach(function (p) {
        var ev = wr[p[0]];
        if (!ev) return;
        try {
          if (!on) ev.removeListener(p[1]);
          else if (p[2]) ev.addListener(p[1], filter, p[2]);
          else ev.addListener(p[1], filter);
        } catch (e) { dbg("debugger: webRequest", p[0], errorMessage(e)); }
      });
    }
    function anyNetwork() {
      return Object.keys(sessions).some(function (id) { return sessions[id].network; });
    }

    // ── Reports from the page ──
    function onReports(sender, reports) {
      var tabId = sender && sender.tab ? sender.tab.id : undefined;
      var s = tabId !== undefined ? sessions[tabId] : null;
      if (!s || !Array.isArray(reports)) return;
      var frameId = cdpFrameId(tabId, sender.frameId || 0);
      reports.forEach(function (r) {
        if (!r || typeof r !== "object") return;
        if (r.kind === "dialog") {
          s.dialog = { type: r.type, message: r.message, defaultPrompt: r.defaultPrompt || "", frameId: frameId };
          if (s.page) {
            emit(tabId, "Page.javascriptDialogOpening", { url: r.url || "", frameId: frameId, message: r.message || "", type: r.type, hasBrowserHandler: false, defaultPrompt: r.defaultPrompt || "" });
          }
        } else if (r.kind === "console" && s.runtime) {
          emit(tabId, "Runtime.consoleAPICalled", { type: r.type, args: r.args || [], executionContextId: 1, timestamp: r.t, stackTrace: { callFrames: r.frames || [] } });
        } else if (r.kind === "exception" && s.runtime) {
          emit(tabId, "Runtime.exceptionThrown", {
            timestamp: r.t,
            exceptionDetails: {
              exceptionId: Date.now(), text: r.text || "Uncaught", lineNumber: r.line || 0, columnNumber: r.column || 0, url: r.url || "",
              stackTrace: { callFrames: r.frames || [] }, executionContextId: 1,
              exception: { type: "object", subtype: "error", className: r.className || "Error", description: r.description || "" },
            },
          });
        }
      });
    }

    // ── Commands ──
    function metrics(tabId) { return isolated(tabId, "metrics", {}); }
    function zoomOf(tabId) {
      if (typeof api.tabs.getZoom !== "function") return Promise.resolve(1);
      return Promise.resolve(api.tabs.getZoom(tabId)).then(function (z) { return z > 0 ? z : 1; }, function () { return 1; });
    }
    function toBase64(buffer) {
      var bytes = new Uint8Array(buffer);
      var bin = "";
      for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    function webp(dataUrl, quality) {
      if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") return Promise.resolve(dataUrl);
      var bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return createImageBitmap(new Blob([bytes], { type: "image/png" })).then(function (img) {
        var canvas = new OffscreenCanvas(img.width, img.height);
        canvas.getContext("2d").drawImage(img, 0, 0);
        return canvas.convertToBlob({ type: "image/webp", quality: typeof quality === "number" ? quality / 100 : 0.8 });
      }).then(function (blob) {
        if (!blob || blob.type !== "image/webp") return dataUrl;
        return blob.arrayBuffer().then(function (buf) { return "data:image/webp;base64," + toBase64(buf); });
      }).catch(function () { return dataUrl; });
    }
    // Chrome's screenshot of the viewport is in device pixels: CSS pixels times
    // the page's devicePixelRatio. A clip is a rectangle of the document in CSS
    // pixels, and its scale multiplies that. captureTab multiplies its own scale
    // by the tab's zoom, so the zoom is divided back out.
    function captureScreenshot(tabId, s, p) {
      if (typeof api.tabs.captureTab !== "function") return Promise.reject(protocolError("Page.captureScreenshot needs tabs.captureTab, which this Firefox lacks"));
      var format = p.format === "jpeg" ? "jpeg" : "png";
      var opts = { format: format };
      if (format === "jpeg") opts.quality = typeof p.quality === "number" ? Math.max(0, Math.min(100, p.quality)) : 80;
      var clip = p.clip && typeof p.clip === "object" ? p.clip : null;
      if (clip && !(clip.width > 0 && clip.height > 0 && isFinite(clip.x) && isFinite(clip.y))) {
        return Promise.reject(protocolError("Invalid clip", -32602));
      }
      return Promise.all([metrics(tabId).catch(function () { return null; }), zoomOf(tabId)]).then(function (r) {
        var m = r[0];
        var zoom = r[1];
        var dpr = s.deviceScaleFactor || (m && m.dpr) || 0;
        if (clip) {
          opts.rect = { x: clip.x, y: clip.y, width: clip.width, height: clip.height };
          if (dpr) opts.scale = (dpr * (clip.scale > 0 ? clip.scale : 1)) / zoom;
          else if (clip.scale > 0 && clip.scale !== 1) opts.scale = clip.scale;
        } else if (dpr) {
          opts.scale = dpr / zoom;
        }
        return api.tabs.captureTab(tabId, opts);
      }).then(function (url) {
        return p.format === "webp" ? webp(String(url), p.quality) : String(url);
      }).then(function (url) {
        return { data: url.slice(url.indexOf(",") + 1) };
      });
    }
    function layoutMetrics(tabId) {
      return metrics(tabId).then(function (m) {
        var css = { pageX: m.sx, pageY: m.sy, clientWidth: m.cw, clientHeight: m.ch };
        var vv = m.vv || { x: 0, y: 0, px: m.sx, py: m.sy, w: m.iw, h: m.ih, s: 1 };
        var visual = { offsetX: vv.x, offsetY: vv.y, pageX: vv.px, pageY: vv.py, clientWidth: vv.w, clientHeight: vv.h, scale: vv.s, zoom: 1 };
        var content = { x: 0, y: 0, width: m.sw, height: m.sh };
        var device = function (o, keys) {
          var out = {};
          for (var k in o) out[k] = keys.indexOf(k) >= 0 ? o[k] * m.dpr : o[k];
          return out;
        };
        return {
          layoutViewport: device(css, ["clientWidth", "clientHeight"]),
          visualViewport: device(visual, ["clientWidth", "clientHeight"]),
          contentSize: device(content, ["width", "height"]),
          cssLayoutViewport: css, cssVisualViewport: visual, cssContentSize: content,
        };
      });
    }
    function frameTree(tabId) {
      var nav = api.webNavigation;
      var frames = nav && nav.getAllFrames ? Promise.resolve(nav.getAllFrames({ tabId: tabId })) : getTab(tabId).then(function (t) { return [{ frameId: 0, parentFrameId: -1, url: t.url }]; });
      return frames.then(function (list) {
        var nodes = {};
        (list || []).forEach(function (f) {
          var origin = "";
          try { origin = new URL(f.url).origin; } catch (e) {}
          var frame = { id: cdpFrameId(tabId, f.frameId), loaderId: String(tabId), url: f.url, domainAndRegistry: "", securityOrigin: origin, mimeType: "text/html", secureContextType: /^https:/.test(f.url) ? "Secure" : "InsecureScheme", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] };
          if (f.frameId !== 0) frame.parentId = cdpFrameId(tabId, f.parentFrameId > 0 ? f.parentFrameId : 0);
          nodes[f.frameId] = { frame: frame, childFrames: [] };
        });
        (list || []).forEach(function (f) {
          if (f.frameId === 0) return;
          var parent = nodes[f.parentFrameId > 0 ? f.parentFrameId : 0];
          if (parent) parent.childFrames.push(nodes[f.frameId]);
        });
        var root = nodes[0];
        if (!root) throw protocolError("Cannot find the main frame");
        return { frameTree: root };
      });
    }
    // Resolves with { error, sameDocument } once the tab's top frame commits a
    // navigation, fails, or moves within the document to `url`.
    function waitForCommit(tabId, url, ms) {
      return new Promise(function (resolve) {
        var timer = setTimeout(function () { finish(null); }, ms);
        function finish(error, sameDocument) {
          clearTimeout(timer);
          if (commitWaiters[tabId] === finish) delete commitWaiters[tabId];
          resolve({ error: error, sameDocument: !!sameDocument });
        }
        finish.url = url;
        commitWaiters[tabId] = finish;
      });
    }
    function targetInfo(tab) {
      return {
        targetId: "tab-" + tab.id, type: "page", title: tab.title || "", url: tab.url || "", attached: !!sessions[tab.id],
        canAccessOpener: false, browserContextId: "default",
      };
    }
    function targetTab(params, tabId) {
      var m = /^tab-(\d+)$/.exec(String(params.targetId || ""));
      return m ? Number(m[1]) : tabId;
    }
    function mouseEvent(tabId, p) {
      var TYPES = { mousePressed: 1, mouseReleased: 1, mouseMoved: 1, mouseWheel: 1 };
      var BUTTONS = { none: -1, left: 0, middle: 1, right: 2, back: 3, forward: 4 };
      if (!TYPES[p.type]) return Promise.reject(protocolError("Invalid parameters: type", -32602));
      if (!isFinite(p.x) || !isFinite(p.y)) return Promise.reject(protocolError("Invalid parameters: x, y", -32602));
      var q = {
        type: p.type, x: Number(p.x), y: Number(p.y),
        button: Object.prototype.hasOwnProperty.call(BUTTONS, p.button) ? BUTTONS[p.button] : -1,
        buttons: typeof p.buttons === "number" ? p.buttons : 0, clickCount: p.clickCount | 0, modifiers: p.modifiers | 0,
        deltaX: Number(p.deltaX) || 0, deltaY: Number(p.deltaY) || 0,
      };
      return inFrames(tabId, "mouse", q).then(function (r) {
        if (!r || !r.open) return {};
        return getTab(tabId).then(function (tab) {
          return api.tabs.create({ url: r.open.url, active: r.open.active, openerTabId: tabId, index: tab.index + 1, windowId: tab.windowId });
        }).then(function () { return {}; }, function () { return {}; });
      });
    }
    function keyEvent(tabId, p) {
      var TYPES = { keyDown: 1, rawKeyDown: 1, char: 1, keyUp: 1 };
      if (!TYPES[p.type]) return Promise.reject(protocolError("Invalid parameters: type", -32602));
      var q = {
        type: p.type, key: typeof p.key === "string" ? p.key : "", code: typeof p.code === "string" ? p.code : "",
        text: typeof p.text === "string" ? p.text : "", keyCode: p.windowsVirtualKeyCode || p.nativeVirtualKeyCode || 0,
        modifiers: p.modifiers | 0, autoRepeat: !!p.autoRepeat, location: p.location | 0,
        commands: Array.isArray(p.commands) ? p.commands : [],
      };
      return inFrames(tabId, "key", q).then(function () { return {}; });
    }

    var COMMANDS = {
      "Page.enable": function (tabId, s) { s.page = true; persist(); return {}; },
      "Page.disable": function (tabId, s) { s.page = false; persist(); return {}; },
      "Page.captureScreenshot": function (tabId, s, p) { return captureScreenshot(tabId, s, p); },
      "Page.getLayoutMetrics": function (tabId) { return layoutMetrics(tabId); },
      "Page.getFrameTree": function (tabId) { return frameTree(tabId); },
      "Page.navigate": function (tabId, s, p) {
        if (typeof p.url !== "string" || !p.url) return Promise.reject(protocolError("Invalid parameters: url", -32602));
        var url = p.url;
        try { url = new URL(p.url).href; } catch (e) {}
        var committed = waitForCommit(tabId, url, 30000);
        return Promise.resolve(api.tabs.update(tabId, { url: p.url })).then(function () {
          return committed;
        }, function (err) {
          var waiter = commitWaiters[tabId];
          if (waiter) waiter(null);
          throw protocolError(errorMessage(err));
        }).then(function (outcome) {
          // Chrome leaves out the loaderId of a same-document navigation.
          var out = { frameId: String(tabId) };
          if (!outcome.sameDocument) out.loaderId = String(tabId);
          if (outcome.error) out.errorText = outcome.error;
          return out;
        });
      },
      "Page.reload": function (tabId, s, p) {
        return Promise.resolve(api.tabs.reload(tabId, { bypassCache: !!p.ignoreCache })).then(function () { return {}; });
      },
      "Page.bringToFront": function (tabId) {
        return getTab(tabId).then(function (tab) {
          return Promise.resolve(api.tabs.update(tabId, { active: true })).then(function () {
            return api.windows && api.windows.update ? api.windows.update(tab.windowId, { focused: true }) : null;
          });
        }).then(function () { return {}; });
      },
      "Page.close": function (tabId) { return Promise.resolve(api.tabs.remove(tabId)).then(function () { return {}; }); },
      "Page.handleJavaScriptDialog": function (tabId, s, p) {
        var d = s.dialog;
        if (!d) return Promise.reject(protocolError("No dialog is showing", -32602));
        s.dialog = null;
        emit(tabId, "Page.javascriptDialogClosed", { frameId: d.frameId, result: p.accept !== false, userInput: typeof p.promptText === "string" ? p.promptText : d.defaultPrompt });
        return {};
      },
      "Runtime.enable": function (tabId, s) {
        s.runtime = true;
        persist();
        return main(tabId, "hookConsole", {}).catch(noop).then(function () {
          executionContext(tabId);
          return {};
        });
      },
      "Runtime.disable": function (tabId, s) {
        s.runtime = false;
        persist();
        return main(tabId, "unhook", { what: "console" }).catch(noop).then(function () { return {}; });
      },
      "Runtime.evaluate": function (tabId, s, p) {
        var run = main(tabId, "evaluate", {
          expression: p.expression, returnByValue: !!p.returnByValue, awaitPromise: !!p.awaitPromise,
          replMode: !!p.replMode, objectGroup: p.objectGroup,
        });
        if (!(p.timeout > 0)) return run;
        // Code that runs too long can't be stopped from outside the page; the
        // caller gets V8's answer for a terminated evaluation instead.
        return Promise.race([run, new Promise(function (resolve) {
          setTimeout(function () {
            resolve({
              result: { type: "undefined" },
              exceptionDetails: { exceptionId: Date.now(), text: "Uncaught", lineNumber: 0, columnNumber: 0, exception: { type: "object", subtype: "error", className: "Error", description: "Error: execution was terminated" } },
            });
          }, p.timeout);
        })]);
      },
      "Runtime.callFunctionOn": function (tabId, s, p) {
        if (typeof p.functionDeclaration !== "string") return Promise.reject(protocolError("Invalid parameters: functionDeclaration", -32602));
        return main(tabId, "callFunctionOn", p);
      },
      "Runtime.getProperties": function (tabId, s, p) { return main(tabId, "getProperties", p); },
      "Runtime.awaitPromise": function (tabId, s, p) { return main(tabId, "awaitPromise", p); },
      "Runtime.releaseObject": function (tabId, s, p) { return main(tabId, "releaseObject", p); },
      "Runtime.releaseObjectGroup": function (tabId, s, p) { return main(tabId, "releaseObjectGroup", p); },
      "Input.dispatchMouseEvent": function (tabId, s, p) { return mouseEvent(tabId, p); },
      "Input.dispatchKeyEvent": function (tabId, s, p) { return keyEvent(tabId, p); },
      "Input.insertText": function (tabId, s, p) {
        return inFrames(tabId, "insertText", { text: typeof p.text === "string" ? p.text : "" }).then(function () { return {}; });
      },
      "Network.enable": function (tabId, s, p) {
        s.network = true;
        s.maxPostDataSize = typeof p.maxPostDataSize === "number" ? p.maxPostDataSize : 0;
        persist();
        hookNetwork(true);
        return {};
      },
      "Network.disable": function (tabId, s) {
        s.network = false;
        persist();
        if (!anyNetwork()) hookNetwork(false);
        return {};
      },
      "Emulation.setDeviceMetricsOverride": function (tabId, s, p) {
        // Only the scale factor can be honoured: it sets the screenshot scale.
        s.deviceScaleFactor = p.deviceScaleFactor > 0 ? p.deviceScaleFactor : 0;
        persist();
        return {};
      },
      "Emulation.clearDeviceMetricsOverride": function (tabId, s) { s.deviceScaleFactor = 0; persist(); return {}; },
      "Target.getTargets": function () {
        return Promise.resolve(api.tabs.query({})).then(function (tabs) { return { targetInfos: (tabs || []).map(targetInfo) }; });
      },
      "Target.getTargetInfo": function (tabId, s, p) {
        return getTab(targetTab(p, tabId)).then(function (tab) { return { targetInfo: targetInfo(tab) }; });
      },
      "Target.createTarget": function (tabId, s, p) {
        var url = typeof p.url === "string" && p.url ? p.url : "about:blank";
        var made = p.newWindow && api.windows
          ? Promise.resolve(api.windows.create({ url: url, focused: !p.background })).then(function (w) { return w.tabs[0]; })
          : Promise.resolve(api.tabs.create({ url: url, active: !p.background }));
        return made.then(function (tab) { return { targetId: "tab-" + tab.id }; });
      },
      "Target.closeTarget": function (tabId, s, p) {
        return Promise.resolve(api.tabs.remove(targetTab(p, tabId))).then(function () { return { success: true }; });
      },
      "Target.activateTarget": function (tabId, s, p) {
        return Promise.resolve(api.tabs.update(targetTab(p, tabId), { active: true })).then(function () { return {}; });
      },
      "Accessibility.getFullAXTree": function (tabId) { return main(tabId, "axTree", {}); },
    };
    ["getDocument", "describeNode", "querySelector", "querySelectorAll", "resolveNode", "requestNode", "getBoxModel",
      "getContentQuads", "scrollIntoViewIfNeeded", "focus", "getOuterHTML", "getAttributes"].forEach(function (m) {
      COMMANDS["DOM." + m] = function (tabId, s, p) { return main(tabId, "dom", { method: m, params: p }); };
    });

    function sendCommand(target, method, params) {
      var tabId = cdpTabOf(target);
      var s = sessions[tabId];
      if (!s) throw new Error("Debugger is not attached to the tab with id: " + tabId + ".");
      if (typeof method !== "string" || !method) throw protocolError("Invalid parameters: method", -32602);
      var p = params && typeof params === "object" ? params : {};
      dbg("debugger:", method, "tab", tabId);
      if (Object.prototype.hasOwnProperty.call(COMMANDS, method)) return COMMANDS[method](tabId, s, p);
      // Unsupported first: Fetch.enable would otherwise pass as a no-op enable.
      if (Object.prototype.hasOwnProperty.call(CDP_UNSUPPORTED, method)) throw protocolError(method + " isn't available in Firefox: " + CDP_UNSUPPORTED[method]);
      if (CDP_NOOP_RE.test(method)) return {};
      throw protocolError("'" + method + "' wasn't found", -32601);
    }
    function attach(target, version) {
      var tabId = cdpTabOf(target);
      if (version != null && !/^1\.[0-3]$/.test(String(version))) {
        throw new Error("Requested protocol version is not supported: " + version + ".");
      }
      if (sessions[tabId]) throw new Error("Another debugger is already attached to the tab with id: " + tabId + ".");
      return getTab(tabId).then(function (tab) {
        if (cdpRestricted(tab.url)) throw new Error("Cannot attach to this target. Firefox doesn't let add-ons script " + tab.url + ".");
        if (sessions[tabId]) throw new Error("Another debugger is already attached to the tab with id: " + tabId + ".");
        sessions[tabId] = { page: false, runtime: false, network: false, maxPostDataSize: 0, deviceScaleFactor: 0, dialog: null };
        persist();
        hookLifecycle();
        updateKeepAlive();
        return hookPage(tabId);
      });
    }
    function detach(target) {
      var tabId = cdpTabOf(target);
      if (!sessions[tabId]) throw new Error("Debugger is not attached to the tab with id: " + tabId + ".");
      ended(tabId, null);
      // Every frame got the dialog hook. A tab that has gone takes its hooks
      // with it.
      return everyFrame(tabId, "MAIN", cdpMain, ["unhook", { what: "all" }, CDP_PAGE_KEY]).then(noop, noop);
    }
    function getTargets() {
      return Promise.resolve(api.tabs.query({})).then(function (tabs) {
        return (tabs || []).map(function (tab) {
          var t = { type: "page", id: "tab-" + tab.id, tabId: tab.id, title: tab.title || "", url: tab.url || "", attached: !!sessions[tab.id] };
          if (tab.favIconUrl) t.faviconUrl = tab.favIconUrl;
          return t;
        });
      });
    }

    // Sessions outlive a suspended event page in storage.session, and come back
    // when it starts again, for the tabs that are still there.
    var ready = Promise.resolve(session ? session.get(CDP_STATE_KEY) : null).then(function (r) {
      var saved = r && r[CDP_STATE_KEY];
      if (!saved || typeof saved !== "object") return undefined;
      var ids = Object.keys(saved).map(Number).filter(function (id) { return id >= 0; });
      return Promise.all(ids.map(function (tabId) {
        return getTab(tabId).then(function (tab) {
          if (cdpRestricted(tab.url)) return tabId;
          sessions[tabId] = saved[tabId];
          sessions[tabId].dialog = null;
          return null;
        }, function () { return tabId; });
      })).then(function (gone) {
        gone = gone.filter(function (id) { return id !== null; });
        if (Object.keys(sessions).length) {
          hookLifecycle();
          updateKeepAlive();
          if (anyNetwork()) hookNetwork(true);
          Object.keys(sessions).forEach(function (id) { hookPage(Number(id)); });
        }
        if (gone.length) {
          persist();
          setTimeout(function () {
            gone.forEach(function (tabId) {
              var source = { tabId: tabId };
              det.dispatch(source, "target_closed");
              post({ kind: "detach", source: source, reason: "target_closed" });
            });
          }, 0);
        }
      });
    }).catch(function (e) { dbg("debugger: restoring sessions failed:", errorMessage(e)); });

    var OPS = { attach: attach, detach: detach, sendCommand: sendCommand, getTargets: getTargets };
    function call(op, args) {
      return ready.then(function () {
        if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new Error("Unknown debugger call " + op);
        return OPS[op].apply(null, Array.isArray(args) ? args : []);
      });
    }

    hideInternalMessages(CDP_KEY, function (message, sender) {
      if (!message || typeof message !== "object" || !message[CDP_KEY]) return undefined;
      if (message[CDP_KEY] === "report") { onReports(sender, message.reports); return undefined; }
      if (message[CDP_KEY] !== "call") return undefined;
      return call(message.op, message.args).then(function (value) {
        return { ok: true, value: value === undefined ? null : value };
      }, function (err) {
        return { ok: false, error: errorMessage(err) };
      });
    });

    return { call: call, onEvent: evt.event, onDetach: det.event };
  }

  // ── Extension pages: forward to the background ──
  function debuggerClient() {
    hideInternalMessages(CDP_KEY, null);
    var evt = makeEvent();
    var det = makeEvent();
    try {
      var channel = new BroadcastChannel(CDP_KEY);
      channel.onmessage = function (e) {
        var m = e && e.data;
        if (!m || typeof m !== "object") return;
        if (m.kind === "event") evt.dispatch(m.source, m.method, m.params);
        else if (m.kind === "detach") det.dispatch(m.source, m.reason);
      };
    } catch (e) {}
    return {
      call: function (op, args) {
        var message = { op: op, args: args };
        message[CDP_KEY] = "call";
        return Promise.resolve(api.runtime.sendMessage(message)).then(function (res) {
          if (!res || typeof res !== "object") throw new Error("The background page didn't answer the debugger call.");
          if (!res.ok) throw new Error(res.error);
          return res.value === null ? undefined : res.value;
        });
      },
      onEvent: evt.event,
      onDetach: det.event,
    };
  }

  function debuggerApi(ns, s) {
    return {
      attach: function (target, requiredVersion, cb) {
        if (typeof requiredVersion === "function") { cb = requiredVersion; requiredVersion = undefined; }
        return respond(ns, s.call("attach", [target, requiredVersion]).then(noop), cb);
      },
      detach: function (target, cb) {
        return respond(ns, s.call("detach", [target]).then(noop), cb);
      },
      sendCommand: function (target, method, commandParams, cb) {
        if (typeof commandParams === "function") { cb = commandParams; commandParams = undefined; }
        return respond(ns, s.call("sendCommand", [target, method, commandParams]), cb);
      },
      getTargets: function (cb) { return respond(ns, s.call("getTargets", []), cb); },
      onEvent: s.onEvent,
      onDetach: s.onDetach,
      DetachReason: { CANCELED_BY_USER: "canceled_by_user", TARGET_CLOSED: "target_closed" },
      TargetInfoType: { BACKGROUND_PAGE: "background_page", OTHER: "other", PAGE: "page", WORKER: "worker" },
    };
  }

  function installDebugger() {
    if (!isExtensionPage) return;
    var missing = namespaces.filter(function (ns) {
      try { return ns.debugger == null; } catch (e) { return false; }
    });
    if (!missing.length) return;
    var surface = isBackground ? debuggerHost() : debuggerClient();
    missing.forEach(function (ns) { defineMissing(ns, "debugger", debuggerApi(ns, surface)); });
  }

  try { installDebugger(); } catch (e) { dbg("debugger emulation failed:", errorMessage(e)); }
