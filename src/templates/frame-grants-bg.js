
  // ── The bridged sites in frames of the add-on's own pages ──────────────────
  // A site that lets the extension embed it lists the extension's Chrome
  // origin, chrome-extension://<id>, in its frame-ancestors. This add-on's
  // pages are moz-extension://<random uuid>, so Firefox refuses the frame.
  // Where the site's policy lists the Chrome origin, and the frame was loaded
  // by this add-on's own page with only this add-on's pages above it, the
  // add-on's origin is let in as well. Frames anywhere else are left alone.
  //
  // An MV3 add-on can't edit a CSP in place: webRequest only lets it add
  // policies, which can only make the page stricter, and declarativeNetRequest
  // can only set the header to a fixed value, before any webRequest listener
  // sees the response. A fixed copy of a policy with a per-response script
  // nonce would stop the page's scripts. So the first response shows the
  // policy; if it lists the Chrome origin, a one-off session rule for that URL,
  // loaded by this add-on, sets the policy to the site's own frame-ancestors
  // (plus this add-on), object-src and base-uri, and the frame loads the URL
  // again. Everything else in that frame's policy, script-src included, is
  // dropped. Firefox ignores X-Frame-Options once frame-ancestors is present,
  // as Chrome does, so that header needs nothing.
  (function () {
    var SITES = __FRAME_SITES__;
    var CHROME_ORIGIN = "chrome-extension://__EXTENSION_ID__";
    var wr = api.webRequest;
    var dnr = api.declarativeNetRequest;
    if (!SITES.length || !wr || !wr.onHeadersReceived || !dnr || typeof dnr.updateSessionRules !== "function") return;
    var OWN = "";
    try { OWN = String(api.runtime.getURL("/")).replace(/\/+$/, "").toLowerCase(); } catch (e) {}
    if (!/^moz-extension:\/\/[^/]+$/.test(OWN)) return;
    var OWN_HOST = OWN.slice("moz-extension://".length);
    // Session rule IDs this code owns; the shim's own rules sit just below.
    var FIRST_RULE = 2147480100;
    var RULE_COUNT = 100;
    var nextRule = 0;
    // requestId → the rule added for it, until the second response arrives.
    var pending = Object.create(null);
    var RULE_TTL_MS = 60000;

    function ownRule(id) { return id >= FIRST_RULE && id < FIRST_RULE + RULE_COUNT; }

    // The shim keeps these rules out of the add-on's own session-rule calls;
    // Firefox's methods sit under __lavaductNative on its wrappers.
    function nativeDnr(name) { var f = dnr[name]; return (f && f.__lavaductNative) || f; }
    function getRules() { return nativeDnr("getSessionRules").call(dnr); }
    function updateRules(options) { return nativeDnr("updateSessionRules").call(dnr, options); }

    // A background that restarts loses track of its rules; clear them first.
    var ready = Promise.resolve()
      .then(function () { return getRules(); })
      .then(function (rules) {
        var stale = (rules || []).map(function (r) { return r.id; }).filter(ownRule);
        if (stale.length) return updateRules({ removeRuleIds: stale });
      })
      .catch(function (e) { DBG("[frame-grants] clearing old rules failed:", e); });

    function dropRule(id) {
      Promise.resolve()
        .then(function () { return updateRules({ removeRuleIds: [id] }); })
        .catch(function (e) { DBG("[frame-grants] removing rule", id, "failed:", e); });
    }

    // The add-on's rules for a URL, found by their filter: what a restarted
    // background uses to clean up after a frame it let in before.
    function dropRulesFor(url) {
      Promise.resolve()
        .then(function () { return getRules(); })
        .then(function (rules) {
          var ids = (rules || []).filter(function (r) {
            if (!ownRule(r.id) || !r.condition || typeof r.condition.regexFilter !== "string") return false;
            try { return new RegExp(r.condition.regexFilter).test(url); } catch (e) { return false; }
          }).map(function (r) { return r.id; });
          if (ids.length) return updateRules({ removeRuleIds: ids });
        })
        .catch(function () {});
    }

    function ownPage(url) {
      var u = String(url || "").toLowerCase();
      return u === OWN || u.indexOf(OWN + "/") === 0;
    }

    // Loaded by this add-on's page, with only this add-on's pages above it.
    function ownFrame(d) {
      if (d.type !== "sub_frame" || !ownPage(d.originUrl)) return false;
      var ancestors = d.frameAncestors;
      if (!Array.isArray(ancestors) || !ancestors.length) return false;
      for (var i = 0; i < ancestors.length; i++) {
        if (!ancestors[i] || !ownPage(ancestors[i].url)) return false;
      }
      return true;
    }

    // Enforced policies, one per comma-separated entry, as directive → sources.
    function policiesOf(headers) {
      var out = [];
      (headers || []).forEach(function (h) {
        if (!h || String(h.name).toLowerCase() !== "content-security-policy" || typeof h.value !== "string") return;
        h.value.split(",").forEach(function (policy) {
          var directives = Object.create(null);
          var any = false;
          policy.split(";").forEach(function (part) {
            var tokens = part.trim().split(/\s+/).filter(Boolean);
            if (!tokens.length) return;
            var name = tokens[0].toLowerCase();
            // The first occurrence of a directive is the one that counts.
            if (!(name in directives)) directives[name] = tokens.slice(1);
            any = true;
          });
          if (any) out.push(directives);
        });
      });
      return out;
    }

    function sourceIs(source, origin) {
      return source.toLowerCase().replace(/\/$/, "") === origin;
    }

    function admitsOwn(policies) {
      return policies.some(function (p) {
        return (p["frame-ancestors"] || []).some(function (s) { return sourceIs(s, OWN); });
      });
    }

    // The policy to put on the frame, or "" when the site doesn't let the
    // Chrome origin frame it: every frame-ancestors must list that origin.
    function grantedPolicy(policies) {
      var framing = policies.filter(function (p) { return "frame-ancestors" in p; });
      if (!framing.length) return "";
      for (var i = 0; i < framing.length; i++) {
        if (!framing[i]["frame-ancestors"].some(function (s) { return sourceIs(s, CHROME_ORIGIN); })) return "";
      }
      return policies.map(function (p) {
        var parts = [];
        if (p["frame-ancestors"]) parts.push(["frame-ancestors"].concat(p["frame-ancestors"], [OWN]).join(" "));
        ["object-src", "base-uri"].forEach(function (name) {
          if (p[name]) parts.push([name].concat(p[name]).join(" "));
        });
        return parts.join("; ");
      }).filter(Boolean).join(", ");
    }

    wr.onHeadersReceived.addListener(function (d) {
      if (!ownFrame(d) || (d.statusCode >= 300 && d.statusCode < 400)) return;
      var policies = policiesOf(d.responseHeaders);
      var p = pending[d.requestId];
      if (p) {
        // The second response: the rule has done its work, or it didn't match
        // and the frame stays refused. Either way, once.
        delete pending[d.requestId];
        clearTimeout(p.timer);
        dropRule(p.rule);
        DBG("[frame-grants]", admitsOwn(policies) ? "let in" : "still refused", d.url);
        return;
      }
      if (admitsOwn(policies)) {
        dropRulesFor(d.url);
        return;
      }
      var policy = grantedPolicy(policies);
      if (!policy) return;
      var rule = FIRST_RULE + (nextRule++ % RULE_COUNT);
      var url = d.url.split("#")[0];
      return ready
        .then(function () {
          return updateRules({
            removeRuleIds: [rule],
            addRules: [{
              id: rule,
              priority: 1,
              action: { type: "modifyHeaders", responseHeaders: [{ header: "content-security-policy", operation: "set", value: policy }] },
              condition: {
                regexFilter: "^" + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:#.*)?$",
                isUrlFilterCaseSensitive: true,
                resourceTypes: ["sub_frame"],
                initiatorDomains: [OWN_HOST],
                tabIds: [d.tabId],
              },
            }],
          });
        })
        .then(function () {
          pending[d.requestId] = {
            rule: rule,
            timer: setTimeout(function () {
              if (pending[d.requestId] && pending[d.requestId].rule === rule) delete pending[d.requestId];
              dropRule(rule);
            }, RULE_TTL_MS),
          };
          DBG("[frame-grants] the site lets", CHROME_ORIGIN, "frame", url, "- loading it again for", OWN);
          return { redirectUrl: d.url };
        }, function (e) {
          DBG("[frame-grants] couldn't add the rule for", url, e);
          return {};
        });
    }, { urls: SITES, types: ["sub_frame"] }, ["blocking", "responseHeaders"]);

    wr.onErrorOccurred.addListener(function (d) {
      var p = pending[d.requestId];
      if (!p) return;
      delete pending[d.requestId];
      clearTimeout(p.timer);
      dropRule(p.rule);
    }, { urls: SITES, types: ["sub_frame"] });
  })();
