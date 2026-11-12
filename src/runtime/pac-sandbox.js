// Evaluates Chrome pac_script configs for the shim's chrome.proxy.settings
// emulation. Loaded by a manifest sandbox page the background frames: a PAC
// script is code, and only a sandbox page may compile it (the add-on's own CSP
// forbids eval elsewhere). The page has no extension API; the background posts
// { __lavaductPac, id, script, url, host, dns } and gets back { result },
// { needDns: name } when the script asked for a name it hasn't resolved yet
// (PAC's DNS calls are synchronous, so the lookup is made by the background
// between rounds), or { error }.
//
// The PAC functions follow Mozilla's ascii_pac_utils.js and Chrome's
// pac_js_library, including Chrome's "Ex" extensions.
"use strict";

var NEED_DNS = { needDns: null };
var DNS = {};

function isIpv4(s) {
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  return !!m && m.slice(1).every(function (p) { return Number(p) <= 255; });
}

function isIpv6(s) {
  return /^[0-9a-f:.]+$/i.test(String(s)) && String(s).indexOf(":") >= 0 && ipv6Words(String(s)) !== null;
}

function ipv4Number(ip) {
  var p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// Eight 16-bit words, or null.
function ipv6Words(s) {
  var v4 = null;
  var m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (!isIpv4(m[2])) return null;
    var n = ipv4Number(m[2]);
    v4 = [n >>> 16, n & 0xffff];
    s = m[1] + "0:0";
  }
  var halves = s.split("::");
  if (halves.length > 2) return null;
  var head = halves[0] ? halves[0].split(":") : [];
  var tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  var fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  var words = head.concat(new Array(halves.length === 2 ? fill : 0).fill("0"), tail).map(function (w) {
    return /^[0-9a-f]{1,4}$/i.test(w) ? parseInt(w, 16) : NaN;
  });
  if (words.some(isNaN)) return null;
  if (v4) { words[6] = v4[0]; words[7] = v4[1]; }
  return words;
}

function lookup(host) {
  host = String(host);
  if (isIpv4(host) || isIpv6(host)) return [host];
  var key = host.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DNS, key)) {
    NEED_DNS.needDns = key;
    throw NEED_DNS;
  }
  return DNS[key] || [];
}

function dnsDomainIs(host, domain) {
  host = String(host); domain = String(domain);
  return host.length >= domain.length && host.substring(host.length - domain.length) === domain;
}

function dnsDomainLevels(host) {
  return String(host).split(".").length - 1;
}

function isPlainHostName(host) {
  return String(host).search(/(\.)|:/) === -1;
}

function localHostOrDomainIs(host, hostdom) {
  host = String(host); hostdom = String(hostdom);
  return host === hostdom || hostdom.lastIndexOf(host + ".", 0) === 0;
}

function shExpMatch(url, pattern) {
  pattern = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + pattern + "$").test(String(url));
}

function dnsResolve(host) {
  var list = lookup(host).filter(isIpv4);
  return list.length ? list[0] : null;
}

function dnsResolveEx(host) {
  return lookup(host).join(";");
}

function isResolvable(host) {
  return dnsResolve(host) !== null;
}

function isResolvableEx(host) {
  return lookup(host).length > 0;
}

function myIpAddress() {
  return "127.0.0.1";
}

function myIpAddressEx() {
  return "127.0.0.1;::1";
}

function getClientVersion() {
  return "1.0";
}

function isInNet(ipaddr, pattern, maskstr) {
  if (!isIpv4(pattern) || !isIpv4(maskstr)) return false;
  if (!isIpv4(ipaddr)) {
    ipaddr = dnsResolve(ipaddr);
    if (ipaddr === null) return false;
  }
  var mask = ipv4Number(maskstr);
  return ((ipv4Number(ipaddr) & mask) >>> 0) === ((ipv4Number(pattern) & mask) >>> 0);
}

function inPrefix(ip, prefix) {
  var slash = String(prefix).split("/");
  if (slash.length !== 2) return false;
  var bits = Number(slash[1]);
  var a, b;
  if (isIpv4(ip) && isIpv4(slash[0])) { a = ipv6Words("::ffff:" + ip); b = ipv6Words("::ffff:" + slash[0]); bits += 96; }
  else { a = ipv6Words(String(ip)); b = ipv6Words(slash[0]); }
  if (!a || !b || !(bits >= 0 && bits <= 128)) return false;
  for (var i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    var m = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((a[i] & m) !== (b[i] & m)) return false;
  }
  return true;
}

function isInNetEx(ipaddr, prefix) {
  var list = isIpv4(ipaddr) || isIpv6(ipaddr) ? [String(ipaddr)] : lookup(ipaddr);
  return list.some(function (ip) { return inPrefix(ip, prefix); });
}

function sortIpAddressList(list) {
  var ips = String(list).split(";").filter(Boolean);
  if (!ips.every(function (ip) { return isIpv4(ip) || isIpv6(ip); })) return false;
  var key = function (ip) { return (isIpv4(ip) ? ipv6Words("::ffff:" + ip) : ipv6Words(ip)).map(function (w) { return ("000" + w.toString(16)).slice(-4); }).join(""); };
  return ips.sort(function (x, y) { var kx = isIpv6(x) ? "0" + key(x) : "1" + key(x), ky = isIpv6(y) ? "0" + key(y) : "1" + key(y); return kx < ky ? -1 : kx > ky ? 1 : 0; }).join(";");
}

var DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function weekdayRange() {
  var args = Array.prototype.slice.call(arguments);
  var gmt = args[args.length - 1] === "GMT";
  if (gmt) args.pop();
  var today = gmt ? new Date().getUTCDay() : new Date().getDay();
  var w1 = DAYS.indexOf(String(args[0]).toUpperCase());
  var w2 = args.length > 1 ? DAYS.indexOf(String(args[1]).toUpperCase()) : w1;
  if (w1 < 0 || w2 < 0) return false;
  return w1 <= w2 ? today >= w1 && today <= w2 : today >= w1 || today <= w2;
}

function dateRange() {
  var args = Array.prototype.slice.call(arguments);
  var gmt = args[args.length - 1] === "GMT";
  if (gmt) args.pop();
  var now = new Date();
  var d = gmt ? now.getUTCDate() : now.getDate();
  var mo = gmt ? now.getUTCMonth() : now.getMonth();
  var y = gmt ? now.getUTCFullYear() : now.getFullYear();
  // Each argument is a day (1-31), a month name, or a year (> 31).
  var kinds = args.map(function (a) {
    if (typeof a === "string" && MONTHS.indexOf(a.toUpperCase()) >= 0) return ["m", MONTHS.indexOf(a.toUpperCase())];
    var n = Number(a);
    return n > 31 ? ["y", n] : ["d", n];
  });
  if (kinds.length === 1) {
    var k = kinds[0];
    return k[0] === "d" ? d === k[1] : k[0] === "m" ? mo === k[1] : y === k[1];
  }
  var half = kinds.length / 2;
  if (half !== Math.floor(half)) return false;
  var from = kinds.slice(0, half), to = kinds.slice(half);
  function stamp(parts, dflt) {
    var r = { y: y, m: dflt === "start" ? 0 : 11, d: dflt === "start" ? 1 : 31 };
    var has = {};
    parts.forEach(function (p) { r[p[0]] = p[1]; has[p[0]] = true; });
    if (!has.y) r.y = y;
    if (!has.m && has.d) r.m = mo;
    return r.y * 10000 + r.m * 100 + r.d;
  }
  var a = stamp(from, "start"), b = stamp(to, "end"), now2 = y * 10000 + mo * 100 + d;
  return a <= b ? now2 >= a && now2 <= b : now2 >= a || now2 <= b;
}

function timeRange() {
  var args = Array.prototype.slice.call(arguments);
  var gmt = args[args.length - 1] === "GMT";
  if (gmt) args.pop();
  var now = new Date();
  var h = gmt ? now.getUTCHours() : now.getHours();
  var mi = gmt ? now.getUTCMinutes() : now.getMinutes();
  var s = gmt ? now.getUTCSeconds() : now.getSeconds();
  var n = args.map(Number);
  if (n.length === 1) return h === n[0];
  var cur, a, b;
  if (n.length === 2) { cur = h; a = n[0]; b = n[1]; return a <= b ? cur >= a && cur < b : cur >= a || cur < b; }
  if (n.length === 4) { cur = h * 60 + mi; a = n[0] * 60 + n[1]; b = n[2] * 60 + n[3]; }
  else if (n.length === 6) { cur = h * 3600 + mi * 60 + s; a = n[0] * 3600 + n[1] * 60 + n[2]; b = n[3] * 3600 + n[4] * 60 + n[5]; }
  else return false;
  return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b;
}

function alert() {}

var compiled = new Map();

// Runs the script's FindProxyForURLEx (Chrome's) or FindProxyForURL.
function evaluatePac(script, url, host, dns) {
  DNS = dns || {};
  var fn = compiled.get(script);
  if (!fn) {
    fn = new Function(script + "\n;return typeof FindProxyForURLEx === 'function' ? FindProxyForURLEx : typeof FindProxyForURL === 'function' ? FindProxyForURL : null;")();
    if (typeof fn !== "function") throw new Error("the PAC script defines no FindProxyForURL function");
    compiled.set(script, fn);
  }
  try {
    var result = fn(url, host);
    if (typeof result !== "string") throw new Error("FindProxyForURL returned " + typeof result + ", not a string");
    return { result: result };
  } catch (e) {
    if (e === NEED_DNS) return { needDns: NEED_DNS.needDns };
    throw e;
  }
}

if (typeof addEventListener === "function") {
  addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__lavaductPac !== true || !e.source) return;
    var reply;
    try {
      reply = evaluatePac(String(d.script), String(d.url), String(d.host), d.dns);
    } catch (err) {
      reply = { error: String((err && err.message) || err) };
    }
    reply.__lavaductPac = true;
    reply.id = d.id;
    e.source.postMessage(reply, "*");
  });
}
