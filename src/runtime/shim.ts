import { writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import type { Manifest } from "../types.js";
import { RUNTIME_DIR } from "../paths.js";
import { NAME } from "../name.js";
import { walkScripts } from "../input/stage.js";

/** Name of the compat shim inside the staged add-on. */
export const SHIM_FILENAME = `${NAME}-compat-shim.js`;
/** The runtime source writeShim fills in. */
const SHIM_TEMPLATE = "firefox-compat-shim.js";
/** Spliced into the shim for --debug builds only; never staged on its own. */
const DEBUG_RING_FILENAME = "debug-ring.js";
/** Spliced into the shim for add-ons that use chrome.debugger; never staged on its own. */
const DEBUGGER_FILENAME = "cdp-emulation.js";

/** Build-time settings baked into the shim. */
export interface ShimConfig {
  /** Emit the shim with tracing on and the persistent ring-buffer logger spliced in. */
  debug?: boolean;
  /** The side panel's page: the Chrome manifest's side_panel.default_path, or the page derivePanelPage found. */
  sidePanelPath?: string;
  /**
   * The Chrome manifest declares no side panel: the extension shows one only on
   * the tabs its code gives one, and the sidebar's page is the one derivePanelPage found.
   */
  noDefaultPanel?: boolean;
  /** Query the side panel's page is opened with (derivePanelWindowQuery or --panel-query). */
  panelQuery?: string;
  /** The extension's Chrome ID, so hardcoded chrome-extension://<id>/_favicon/ URLs are recognised. */
  extensionId?: string;
  /** Emulate chrome.debugger (see usesDebugger). */
  debuggerEmulation?: boolean;
  /** The Chrome background was a service worker; it now runs as an event page. */
  serviceWorker?: boolean;
  /** That worker's script, root-relative: the Chrome manifest's background.service_worker. */
  serviceWorkerScript?: string;
  /** Hosts whose requests from the add-on carry its Chrome origin (see backendHosts). */
  backendHosts?: string[];
  /** The worker's webpack chunk-loading global, when its chunks load ahead of it (see wireBackground). */
  webpackChunkGlobal?: string;
  /** The Chrome manifest asks for userScripts, which Firefox only grants at runtime. */
  userScripts?: boolean;
}

// Parts of the shim with side effects beyond defining a missing member are only
// emitted for an add-on that needs them: favicon support wraps fetch and watches
// <img> elements, the new tab fix wraps tabs.create, a background that claims
// to be a service worker changes what code testing for one does, and so do the
// service worker's `clients` and `registration` in the background and
// navigator.serviceWorker in the extension's pages; the background's Web Lock
// names are translated only for code that takes locks.
const FAVICON_REF_RE = /chrome:\/\/favicon|(?:^|[^\w$])_favicon\//m;
const OFFSCREEN_REF_RE = /\.\s*offscreen\b|\[\s*["']offscreen["']\s*\]/;
const NEW_TAB_REF_RE = /["'`]chrome:\/\/new-?tab(?:-page)?\/?["'`]/i;
const SW_SCOPE_REF_RE = /\bServiceWorkerGlobalScope\b/;
// The worker's clients (`self.clients`, `clients.matchAll(`, `const { clients } = self`),
// and its pages' navigator.serviceWorker: the two ends of one channel.
const SW_CLIENTS_REF_RE = /\b(?:self|globalThis)\s*\.\s*clients\b|\bclients\s*\.\s*(?:matchAll|get|openWindow|claim)\s*\(|\{[^{}]*\bclients\b[^{}]*\}\s*=\s*(?:self|globalThis)\b|\bnavigator\s*\.\s*serviceWorker\b/;
// The worker's own registration, read for members the stand-in provides. A bundle
// that reaches for pushManager picks web push when it finds a registration, and
// Firefox gives add-ons no Push API, so it must keep finding none.
const SW_REGISTRATION_REF_RE = /\b(?:self|globalThis)\s*\.\s*registration\s*(?:\?\.|\.)\s*(?:active|installing|waiting|scope|addEventListener|update|unregister)\b/;
const PUSH_MANAGER_REF_RE = /\.\s*pushManager\b/;
const LOCKS_REF_RE = /\bnavigator\s*\.\s*locks\b/;

interface Usage {
  favicon: boolean;
  offscreen: boolean;
  newTab: boolean;
  serviceWorkerScope: boolean;
  serviceWorkerClients: boolean;
  serviceWorkerRegistration: boolean;
  pushManager: boolean;
  locks: boolean;
}

function scanUsage(dir: string): Usage {
  const found: Usage = {
    favicon: false, offscreen: false, newTab: false, serviceWorkerScope: false,
    serviceWorkerClients: false, serviceWorkerRegistration: false, pushManager: false, locks: false,
  };
  for (const file of walkScripts(dir, [], [".js", ".mjs", ".html", ".htm", ".css"])) {
    if (basename(file) === SHIM_FILENAME) continue;
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!found.favicon) found.favicon = FAVICON_REF_RE.test(src);
    if (/\.m?js$/i.test(file)) {
      if (!found.offscreen) found.offscreen = OFFSCREEN_REF_RE.test(src);
      if (!found.newTab) found.newTab = NEW_TAB_REF_RE.test(src);
      if (!found.serviceWorkerScope) found.serviceWorkerScope = SW_SCOPE_REF_RE.test(src);
      if (!found.serviceWorkerClients) found.serviceWorkerClients = SW_CLIENTS_REF_RE.test(src);
      if (!found.serviceWorkerRegistration) found.serviceWorkerRegistration = SW_REGISTRATION_REF_RE.test(src);
      if (!found.pushManager) found.pushManager = PUSH_MANAGER_REF_RE.test(src);
      if (!found.locks) found.locks = LOCKS_REF_RE.test(src);
    }
  }
  return found;
}

function shimSource(dir: string, config: ShimConfig): string {
  const usage = scanUsage(dir);
  // The config goes in as a JSON literal, so nothing from the manifest is ever
  // interpolated into code. JSON.stringify leaves U+2028/U+2029 raw, which are
  // line terminators inside a JS string literal; escape them.
  const json = JSON.stringify({
    sidePanelPath: (config.sidePanelPath ?? "").split(/[?#]/)[0].replace(/^\/+/, ""),
    noDefaultPanel: config.noDefaultPanel === true,
    panelQuery: (config.panelQuery ?? "").replace(/^\?/, ""),
    extensionId: config.extensionId ?? "",
    favicon: usage.favicon,
    offscreen: usage.offscreen,
    newTab: usage.newTab,
    serviceWorkerScope: config.serviceWorker === true && usage.serviceWorkerScope,
    serviceWorkerScript: config.serviceWorker === true ? (config.serviceWorkerScript ?? "").replace(/^(?:\.?\/)+/, "") : "",
    serviceWorkerClients: config.serviceWorker === true && usage.serviceWorkerClients,
    serviceWorkerRegistration: config.serviceWorker === true && usage.serviceWorkerRegistration && !usage.pushManager,
    serviceWorkerLocks: config.serviceWorker === true && usage.locks,
    backendHosts: config.extensionId ? config.backendHosts ?? [] : [],
    userScriptEvents: config.userScripts === true,
    webpackChunkGlobal: config.webpackChunkGlobal ?? "",
  }).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
  let src = readFileSync(join(RUNTIME_DIR, SHIM_TEMPLATE), "utf-8");
  // Exact-string splices: a build without them never contains their source, so
  // nothing ships disabled-but-present.
  if (config.debug) {
    src = src
      .split("var __SHIM_DEBUG__ = false;").join("var __SHIM_DEBUG__ = true;")
      .split("// __SHIM_DEBUG_RING__").join(readFileSync(join(RUNTIME_DIR, DEBUG_RING_FILENAME), "utf-8"));
  }
  if (config.debuggerEmulation) {
    src = src.split("  // __SHIM_DEBUGGER__\n").join(readFileSync(join(RUNTIME_DIR, DEBUGGER_FILENAME), "utf-8"));
  }
  return src.split("__SHIM_CONFIG_JSON__").join(json);
}

// chrome.debugger calls, and the debugger permission, mean the add-on drives tabs
// through the DevTools protocol.
const DEBUGGER_CALL_RE = /\.\s*debugger\s*\.\s*(?:attach|detach|sendCommand|getTargets|onEvent|onDetach)\b/;

/** Whether the add-on uses chrome.debugger: it asks for the permission, or its code calls the API. */
export function usesDebugger(dir: string, manifest: Manifest): boolean {
  const declared = [manifest.permissions, manifest.optional_permissions].some((list) => Array.isArray(list) && list.includes("debugger"));
  if (declared) return true;
  for (const file of walkScripts(dir)) {
    if (basename(file) === SHIM_FILENAME) continue;
    try {
      if (DEBUGGER_CALL_RE.test(readFileSync(file, "utf-8"))) return true;
    } catch {
      // An unreadable file can't call anything.
    }
  }
  return false;
}

/**
 * The hosts an extension's pages may talk to by its own content security policy
 * (extension_pages connect-src): its backends. Chrome sends them the extension's
 * chrome-extension://<id> origin, which some allow by name; Firefox would send a
 * moz-extension:// origin with a random per-install host. Wildcard hosts give
 * their domain, which covers every subdomain.
 */
export function backendHosts(manifest: Manifest): string[] {
  const cspObj = manifest.content_security_policy;
  const csp = typeof cspObj === "string" ? cspObj : typeof cspObj?.extension_pages === "string" ? cspObj.extension_pages : "";
  const hosts = new Set<string>();
  for (const directive of csp.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name?.toLowerCase() !== "connect-src") continue;
    for (const source of sources) {
      const host = /^(?:(?:https?|wss?):\/\/)?(?:\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:\/.*)?$/i.exec(source)?.[1];
      if (host) hosts.add(host.toLowerCase());
    }
  }
  return [...hosts].sort();
}

/**
 * The page an extension shows in its side panel when the manifest declares no
 * side_panel and the code sets the page at runtime instead:
 * `chrome.sidePanel.setOptions({ path: "sidepanel.html?tabId=" + id })`. The page
 * is the literal head of the path, up to its query or first interpolation, and
 * must exist. Failing that, a lone page named like a side panel counts. Empty when
 * the manifest declares side_panel, the add-on doesn't use chrome.sidePanel, or
 * the bundle names more than one page.
 */
export function derivePanelPage(dir: string, manifest: Manifest): string {
  if (manifest.side_panel !== undefined || manifest.sidebar_action !== undefined) return "";
  const permitted = [manifest.permissions, manifest.optional_permissions].some((list) => Array.isArray(list) && list.includes("sidePanel"));
  const pages = new Set<string>();
  let used = permitted;
  const pathRe = /\bpath\s*:\s*(["'`])\/?([A-Za-z0-9_\-./]+\.html?)(?=[?#"'`$])/g;
  for (const file of walkScripts(dir)) {
    if (basename(file) === SHIM_FILENAME) continue;
    let src: string;
    try { src = readFileSync(file, "utf-8"); } catch { continue; }
    if (!/\bsidePanel\s*\./.test(src)) continue;
    used = true;
    for (let at = src.indexOf("setOptions("); at >= 0; at = src.indexOf("setOptions(", at + 11)) {
      const end = matchBalancedParen(src, at + 10);
      const args = src.slice(at, end < 0 ? at + 600 : end);
      pathRe.lastIndex = 0;
      for (let m = pathRe.exec(args); m; m = pathRe.exec(args)) {
        if (isFile(join(dir, m[2]))) pages.add(m[2].replace(/^\.\//, ""));
      }
    }
  }
  if (!used) return "";
  if (pages.size === 1) return [...pages][0];
  if (pages.size > 1) return "";
  const named = walkHtmlFiles(dir).filter((f) => /side[-_]?panel/i.test(basename(f)));
  return named.length === 1 ? relative(dir, named[0]).split("\\").join("/") : "";
}

/** Write the compat shim into the staged add-on; returns its root-relative file name. */
export function writeShim(dir: string, config: ShimConfig = {}): string {
  writeFileSync(join(dir, SHIM_FILENAME), shimSource(dir, config), "utf-8");
  return SHIM_FILENAME;
}

/** The query the extension itself puts on its side-panel page when it opens that
 *  page as a standalone window, read off the bundle. Chrome opens a docked side panel
 *  with no query, and an extension that also has a detached form opens the same page
 *  through `windows.create({url: "<panel>?mode=window…"})` and branches on the
 *  query at first render. When the docked form embeds something that only Chrome can
 *  frame, the window form is the one that works in Firefox's sidebar, so the derived
 *  query is written into sidebar_action.default_panel.
 *
 *  Only the literal head of the URL, up to the first interpolation, counts, and only
 *  complete `key=value` pairs in it: `sidepanel.html?mode=window&sessionId=${id}`
 *  yields `mode=window`, while a permission popup opened as
 *  `sidepanel.html?tabId=${t}&mcpPermissionOnly=true` yields nothing, since its head
 *  ends in a dynamic value and the constant after it is not the page's mode. A bundle
 *  that opens the page with two different heads disagrees with itself and nothing is
 *  derived: a wrong query can break a panel, no query is the status quo. */
export function derivePanelWindowQuery(dir: string, manifest: Manifest): string {
  // The manifest's side_panel path when declared, else any page whose name contains
  // "sidepanel" (some extensions declare none and set the path through setOptions).
  const sp: unknown = "side_panel" in manifest ? manifest.side_panel : undefined;
  const declared = sp && typeof sp === "object" && "default_path" in sp && typeof sp.default_path === "string"
    ? sp.default_path.split(/[#?]/)[0].replace(/^\/+/, "")
    : "";
  const page = declared
    ? declared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : "[A-Za-z0-9_\\-./]*sidepanel[A-Za-z0-9_\\-./]*\\.html";
  // The URL literal is usually built just before `windows.create(` (a getURL call
  // assigned to a variable) or inline in its argument; look on both sides and take
  // the literal nearest the call, since a neighbouring setOptions path or a second
  // create site can sit inside the same window of text.
  const head = new RegExp("(?:^|[^A-Za-z0-9_.-])" + page + "\\?([A-Za-z0-9_\\-=&%.]*)", "gi");
  const REACH = 600;
  const heads = new Set<string>();
  for (const f of walkScripts(dir)) {
    let src: string;
    try { src = readFileSync(f, "utf-8"); } catch { continue; }
    let at = 0;
    for (;;) {
      const i = src.indexOf("windows.create(", at);
      if (i < 0) break;
      at = i + 15;
      const lo = Math.max(0, i - REACH);
      const win = src.slice(lo, i + REACH);
      let best: { dist: number; query: string } | undefined;
      head.lastIndex = 0;
      for (let m = head.exec(win); m; m = head.exec(win)) {
        const dist = Math.abs(lo + m.index - i);
        if (!best || dist < best.dist) best = { dist, query: m[1] };
      }
      if (!best) continue;
      const pairs = best.query.split("&").filter((kv) => /^[A-Za-z0-9_-]+=[A-Za-z0-9_%.-]+$/.test(kv));
      if (pairs.length > 0) heads.add(pairs.join("&"));
    }
  }
  if (heads.size !== 1) return "";
  return [...heads][0];
}

/**
 * Index just past the first real `<head ...>` tag, skipping any `<head>` that
 * sits inside an HTML comment (`<!-- <head> -->`). Injecting a <script> after a
 * commented-out head buries it inside the comment, where it never runs.
 * Returns -1 when there's no usable head tag.
 */
function headInsertIndex(html: string): number {
  const re = /<head(?=[\s/>])[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // Inside a comment if the last "<!--" before this point has no "-->" before
    // the head tag; an unterminated comment counts as inside too.
    const open = html.lastIndexOf("<!--", m.index);
    if (open !== -1) {
      const close = html.indexOf("-->", open);
      if (close === -1 || close > m.index) continue;
    }
    return m.index + m[0].length;
  }
  return -1;
}

/**
 * Insert markup at the top of the page's head. A page with no `<head>` tag gets it
 * after its doctype: anything but whitespace or comments ahead of `<!DOCTYPE html>`
 * drops the page into quirks mode, which reflows layout built for standards mode.
 * A UTF-8 byte order mark may lead, decoded (U+FEFF) or as latin1 bytes.
 */
const BOM_RE = /^(?:\uFEFF|\u00EF\u00BB\u00BF)/;
export function insertAtHeadStart(html: string, markup: string): string {
  const at = headInsertIndex(html);
  if (at >= 0) return html.slice(0, at) + "\n    " + markup + html.slice(at);
  const doctype = new RegExp(BOM_RE.source + "?(?:\\s|<!--[\\s\\S]*?-->)*<!doctype\\b[^>]*>", "i").exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + "\n" + markup + html.slice(doctype[0].length);
  return markup + "\n" + html;
}

function walkHtmlFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name === "node_modules" || name === ".git" || name.startsWith("__MACOSX")) continue;
    const full = join(dir, name);
    if (entry.isDirectory()) walkHtmlFiles(full, acc);
    else if (entry.isFile() && /\.html?$/i.test(name)) acc.push(full);
  }
  return acc;
}

/**
 * Make the shim the first script of every extension HTML page, nested ones
 * included (options and panel pages often live in subdirectories). The src is
 * root-absolute so it resolves from any depth. Classic scripts in <head> run
 * before deferred and module scripts, so the shim is in place before the page's
 * bundle evaluates. Returns the number of pages changed.
 *
 * Pages are read and written as latin1, one character per byte, so a page in
 * windows-1252 or another non-UTF-8 charset keeps its bytes: the tags looked
 * for and the markup inserted are ASCII either way.
 */
export function injectShimIntoHtmlPages(dir: string, shimFile: string): number {
  const tag = `<script src="/${shimFile}"></script>`;
  let count = 0;
  for (const file of walkHtmlFiles(dir)) {
    const html = readFileSync(file, "latin1");
    if (html.includes(tag)) continue;
    writeFileSync(file, insertAtHeadStart(html, tag), "latin1");
    count++;
  }
  return count;
}

/**
 * Turn the manifest's background into something Firefox runs. Firefox has no
 * background service worker, so a worker becomes an event page loaded from
 * `background.scripts`, where `importScripts()` does not exist:
 *
 * - A classic worker's static importScripts targets are listed ahead of it and
 *   every call is neutralised. When a call has a computed argument (webpack's
 *   chunk loader), the bundle's async chunks are listed too: ahead of the worker
 *   when the shim is there, which hands their queued registrations to the
 *   runtime the moment it takes over the chunk array, so code the worker runs at
 *   startup finds them, as it does in Chrome where importScripts loads a chunk
 *   synchronously. Without the shim nothing would replay them, so they go after
 *   the worker and register through the runtime's push.
 * - A module worker keeps `type: "module"` and nothing is hoisted: static imports
 *   work in module background scripts, and a module worker can't call
 *   importScripts at all.
 * - Existing `scripts` get the shim prepended. A background `page` is left alone;
 *   the HTML injection covers it.
 *
 * Mutates `manifest.background`. `hoisted` lists the importScripts targets in
 * load order.
 */
export function wireBackground(dir: string, manifest: Manifest, shimFile?: string): { converted: boolean; hoisted: string[] } {
  const bg = manifest.background;
  if (!bg || typeof bg !== "object") return { converted: false, hoisted: [] };

  if (Array.isArray(bg.scripts)) {
    // Firefox prefers scripts over service_worker when both are present; a
    // manifest that already lists scripts was written with Firefox in mind.
    delete bg.service_worker;
    if (shimFile && !bg.scripts.includes(shimFile)) bg.scripts = [shimFile, ...bg.scripts];
    return { converted: false, hoisted: [] };
  }

  const sw = typeof bg.service_worker === "string" ? bg.service_worker.replace(/^(?:\.?\/)+/, "") : "";
  if (!sw) return { converted: false, hoisted: [] };

  const isModule = bg.type === "module";
  let hoisted: string[] = [];
  let chunks: string[] = [];
  if (!isModule) {
    const hoist = hoistImportScripts(dir, sw);
    hoisted = hoist.targets;
    if (hoist.dynamic) chunks = collectWebpackChunks(dir, sw, new Set(hoisted));
  }
  const scripts: string[] = [];
  const order = shimFile ? [shimFile, ...hoisted, ...chunks, sw] : [...hoisted, sw, ...chunks];
  for (const s of order) {
    if (!scripts.includes(s)) scripts.push(s);
  }
  manifest.background = isModule ? { scripts, type: "module" } : { scripts };
  return { converted: true, hoisted };
}

/**
 * Lexing walk shared by matchBalancedParen and pushArrayElementCount so the two
 * can never disagree about what is code. Invokes onCode(c, i) for every character
 * outside string/template/comment/regex content. Template literals get full
 * `${…}` handling: interpolations re-enter code mode, nested templates included
 * (MetaMask's 1MB chunk 6078 nests templates two deep).
 * Returns the index where onCode returned true, else -1 (end of input reached,
 * or an unterminated construct).
 */
function walkCode(src: string, start: number, onCode: (c: string, i: number) => boolean): number {
  // Context stack: "T" = inside template-literal text; a number = inside a `${}`
  // interpolation, holding its open-brace count so the matching "}" hands control
  // back to the surrounding template text instead of being reported as code.
  const stack: Array<"T" | number> = [];
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    const top = stack.length ? stack[stack.length - 1] : undefined;
    if (top === "T") {
      if (c === "\\") { i++; continue; }
      if (c === "`") { stack.pop(); continue; }
      if (c === "$" && src[i + 1] === "{") { stack.push(0); i++; continue; }
      continue;
    }
    if (c === "`") { stack.push("T"); continue; }
    if (typeof top === "number") {
      if (c === "}") {
        if (top === 0) { stack.pop(); continue; } // closes the ${ — resume template text
        stack[stack.length - 1] = top - 1;
      } else if (c === "{") {
        stack[stack.length - 1] = top + 1;
      }
    }
    if (c === '"' || c === "'") {
      // skip the string literal
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === c) break;
        i++;
      }
      continue;
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      // Always a comment: a regex literal's first body char can never be `/` or `*`
      // (RegularExpressionFirstChar excludes both), so `//` and `/*` are comments
      // regardless of expression position.
      if (src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        if (nl < 0) return -1;
        i = nl;
      } else {
        const close = src.indexOf("*/", i + 2);
        if (close < 0) return -1;
        i = close + 1;
      }
      continue;
    }
    if (c === "/" && startsRegexAt(src, i, start)) {
      // A regex literal whose body doesn't start with `/`/`*` (e.g. /\//, /a-z/).
      i = skipRegex(src, i);
      if (i < 0) return -1;
      continue;
    }
    if (onCode(c, i)) return i;
  }
  return -1;
}

/**
 * Given the index of an opening "(" in `src`, return the index just PAST its
 * matching ")", honoring nested parens and skipping string/template/comment/regex
 * content (see walkCode). Returns -1 if no balanced close is found. A ")" inside
 * a template interpolation still counts — interpolations are code.
 */
export function matchBalancedParen(src: string, open: number): number {
  let depth = 0;
  const at = walkCode(src, open, (c) => {
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return true;
    }
    return false;
  });
  return at < 0 ? -1 : at + 1;
}

// Keywords a regex literal can directly follow (`return/,/.test(x)` is how terser
// emits it). An identifier ending just before the `/` that ISN'T one of these means
// division (`n / 2`).
const REGEX_PRECEDING_KEYWORDS: Record<string, true> = {
  return: true, typeof: true, instanceof: true, in: true, of: true, new: true, delete: true,
  void: true, throw: true, case: true, do: true, else: true, yield: true, await: true,
};

// Does the `/` at src[slashIdx] begin a regex literal (vs division)? Looks back at
// the previous significant char: operators/openers/commas can't end a value, so a
// regex follows; an identifier char means division UNLESS the whole word is a
// keyword like `return`. Conservative: when unsure, treats `/` as division.
function startsRegexAt(src: string, slashIdx: number, floor: number): boolean {
  let j = slashIdx - 1;
  while (j >= floor && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j--;
  if (j < floor) return true; // expression start
  const c = src[j];
  if ("(,=:[!&|?{};+-*%^~<>".indexOf(c) >= 0) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= floor && /[A-Za-z0-9_$]/.test(src[k])) k--;
    // A word matching a keyword is only the keyword when it's NOT a member name:
    // `o.return / 2` is division (property `return`), not `return /regex/`. Look
    // past whitespace before the word — a `.` (dot or `?.`) means member access.
    let d = k;
    while (d >= floor && (src[d] === " " || src[d] === "\t" || src[d] === "\n" || src[d] === "\r")) d--;
    if (src[d] === ".") return false;
    return Object.hasOwn(REGEX_PRECEDING_KEYWORDS, src.slice(k + 1, j + 1));
  }
  return false;
}

// Given index `start` at the opening `/` of a regex literal, return the index of its
// closing `/`, honoring `\` escapes and `[...]` character classes (where `/` is not a
// delimiter). Returns -1 if unterminated.
function skipRegex(src: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i;
    else if (ch === "\n") return -1;
  }
  return -1;
}

interface HoistResult {
  /** Root-relative paths of the hoisted files, in the order they must load. */
  targets: string[];
  /** True when at least one call had a non-literal argument — those targets are
   *  unknowable at staging time, so the caller looks for webpack chunks. */
  dynamic: boolean;
}

function hoistImportScripts(dir: string, swPath: string): HoistResult {
  if (!existsSync(join(dir, swPath))) return { targets: [], dynamic: false };

  // Hoisted files can themselves call importScripts (a library pulled in by the
  // worker pulling in its own dependency), so neutralise and hoist depth-first: a
  // file's targets load before the file, as they would have run by the time the
  // importer's later code executes. importScripts resolves every URL against the
  // worker's own location, so one resolve base (the worker's dir) serves the whole
  // tree. `seen` doubles as the cycle guard. Every call in every hoisted file is
  // neutralised, so no runtime importScripts stub is needed; defining one would
  // break the `typeof importScripts === "function"` worker-detection idiom.
  const swDir = dirname(swPath);
  const targets: string[] = [];
  const seen = new Set<string>();
  let dynamic = false;

  const hoistFile = (rootRel: string): void => {
    const res = neutralizeImportScripts(dir, rootRel, swDir);
    if (res.dynamic) dynamic = true;
    for (const target of res.targets) {
      if (seen.has(target)) continue;
      seen.add(target);
      hoistFile(target);
      targets.push(target);
    }
  };
  hoistFile(swPath);
  return { targets, dynamic };
}

// `importScripts(chrome.runtime.getURL("js/a.js"))` (Wappalyzer) names a file as surely
// as a bare literal does, but relative to the extension ROOT, not the worker's dir.
// Rewrite each such call to the root-absolute literal "/js/a.js" before the argument
// list is classified, so it is hoisted like any static target instead of being
// neutralized as "dynamic" with its code lost. Shared with the analyzer.
const GETURL_LITERAL_RE = /(?:[A-Za-z_$][\w$]*\s*\.\s*)*runtime\s*\.\s*getURL\s*\(\s*(["'`])([^"'`$\\]+)\1\s*\)/g;
export function rootLiteralsFromGetURL(argList: string): string {
  return argList.replace(GETURL_LITERAL_RE, (_m, _q, lit: string) => JSON.stringify("/" + lit.replace(/^\/+/, "")));
}

/**
 * Replace every importScripts(...) call in ONE file with a void-0 no-op and
 * return the resolvable string-literal targets (root-relative, existing on disk)
 * plus whether any call had a runtime-computed argument.
 */
function neutralizeImportScripts(dir: string, rootRel: string, resolveDir: string): { targets: string[]; dynamic: boolean } {
  const filePath = join(dir, rootRel);
  let src: string;
  try {
    src = readFileSync(filePath, "utf-8");
  } catch {
    return { targets: [], dynamic: false };
  }
  if (!/\bimportScripts\s*\(/.test(src)) return { targets: [], dynamic: false };

  const targets: string[] = [];
  let dynamic = false;
  // The end of each call comes from matchBalancedParen, not a `[^)]*` regex: an
  // argument can contain parens itself (webpack's `importScripts(o.p+o.u(t))`), and
  // cutting at the first ")" leaves a dangling one behind, a SyntaxError.
  // The match also takes any receiver chain ending in `.importScripts(`, so
  // `self.importScripts(...)` (Workbox) or a bundler alias (`var g=self;
  // g.importScripts(…)`) is replaced as one span; leaving the receiver behind would
  // emit `self.void 0`. A bare `importScripts(` still matches via the leading `\b`.
  const callOpenRe = /(?:[A-Za-z_$][\w$]*(?:\s*(?:\?\.\s*[\w$]+|\.\s*[\w$]+|\[[^\]]*\]))*\s*(?:\?\.|\.)\s*)?\bimportScripts\s*\(/g;
  let neutralized = 0;
  let out = "";
  let last = 0;
  let mm: RegExpExecArray | null;
  while ((mm = callOpenRe.exec(src))) {
    const openParen = mm.index + mm[0].length - 1; // index of the "(" itself
    const end = matchBalancedParen(src, openParen); // index just past the ")"
    if (end < 0) continue; // unbalanced (shouldn't happen in valid JS) → leave as-is
    const argList = rootLiteralsFromGetURL(src.slice(openParen + 1, end - 1));
    const classified = importScriptsTargets(src, mm.index, argList);
    if (classified.dynamic) dynamic = true;
    for (const literal of classified.literals) {
      // A leading "/" is the extension root; anything else is relative to the
      // worker's own dir. join() would glue a root-absolute literal onto the
      // worker's dir ("src" + "/src/lib/a.js"), a path that exists nowhere.
      const fromRoot = (literal.startsWith("/") ? literal.slice(1) : join(resolveDir, literal))
        .split("\\").join("/");
      // Unresolved, or not a file → no script entry; the call is still neutralised.
      if (isFile(join(dir, fromRoot))) targets.push(fromRoot);
    }
    out += src.slice(last, mm.index) + "void 0 /* importScripts hoisted to background.scripts */";
    last = end;
    neutralized++;
    callOpenRe.lastIndex = end; // continue scanning after the full call
  }
  out += src.slice(last);

  // Write whenever ANY call was neutralised: an unresolved target must be
  // de-fanged too, or it throws on the undefined global.
  if (neutralized > 0) writeFileSync(filePath, out, "utf-8");
  return { targets, dynamic };
}

/**
 * Classify one importScripts call's arguments (getURL literals already rewritten):
 * the file names it statically imports, and whether any argument is computed at
 * runtime. A whole string literal names a file. A literal that is only part of an
 * expression names nothing (`importScripts('./' + script)` is not "./"); a loop
 * over a literal list is resolved instead. Shared with the analyzer.
 */
export function importScriptsTargets(src: string, callAt: number, argList: string): { literals: string[]; dynamic: boolean } {
  const literals: string[] = [];
  let dynamic = false;
  // "…" | '…' | an interpolation-free template (a `${…}` one is runtime-computed).
  const WHOLE_LITERAL = /^"([^"\\]*)"$|^'([^'\\]*)'$|^`((?:[^`$\\]|\$(?!\{))*)`$/;
  for (const raw of splitTopLevelArgs(argList)) {
    let arg = raw.trim();
    let whole = WHOLE_LITERAL.exec(arg);
    // Only drop comments when the argument isn't already one literal, so a URL's
    // "//" survives while `"a.js" /*x*/` still reads as static.
    if (!whole) {
      arg = arg.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").trim();
      if (!arg) continue;
      whole = WHOLE_LITERAL.exec(arg);
    }
    if (whole) { literals.push(whole[1] ?? whole[2] ?? whole[3]); continue; }
    const fromLoop = importsFromLiteralList(src, callAt, arg);
    if (fromLoop) literals.push(...fromLoop);
    else dynamic = true;
  }
  return { literals, dynamic };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Split a call's argument text at its top-level commas (strings, brackets aware). */
function splitTopLevelArgs(argList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < argList.length; i++) {
    const c = argList[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = argList.indexOf(c, i + 1);
      if (close < 0) break;
      i = close;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(argList.slice(start, i));
      start = i + 1;
    }
  }
  out.push(argList.slice(start));
  return out;
}

/**
 * The worker entry point that imports a list: `for (const s of SCRIPTS)
 * importScripts(s)`, or with a prefix/suffix (`'./' + s`), where SCRIPTS is an array
 * of string literals in the same file or inline in the loop (Zotero's
 * background-worker.js). Returns the names in order, or null when the argument or
 * the list is anything else.
 */
function importsFromLiteralList(src: string, callAt: number, arg: string): string[] | null {
  const shape = /^(?:(["'`])([^"'`\\$]*)\1\s*\+\s*)?([A-Za-z_$][\w$]*)(?:\s*\+\s*(["'`])([^"'`\\$]*)\4)?$/.exec(arg);
  if (!shape) return null;
  const prefix = shape[2] ?? "", name = shape[3], suffix = shape[5] ?? "";
  const loopRe = new RegExp(`\\bfor\\s*\\(\\s*(?:let|const|var)\\s+${name.replace(/\$/g, "\\$")}\\s+of\\s+`, "g");
  let loopAt = -1, loopEnd = -1;
  for (let m: RegExpExecArray | null; (m = loopRe.exec(src)) && m.index < callAt; ) { loopAt = m.index; loopEnd = m.index + m[0].length; }
  if (loopAt < 0) return null;
  let listText: string | null = null;
  if (src[loopEnd] === "[") {
    const close = src.indexOf("]", loopEnd);
    if (close > 0) listText = src.slice(loopEnd + 1, close);
  } else {
    const ident = /^([A-Za-z_$][\w$]*)\s*\)/.exec(src.slice(loopEnd));
    if (!ident) return null;
    const decl = new RegExp(`\\b(?:var|let|const)\\s+${ident[1].replace(/\$/g, "\\$")}\\s*=\\s*\\[`).exec(src);
    if (!decl) return null;
    const open = decl.index + decl[0].length;
    const close = src.indexOf("]", open);
    if (close > 0) listText = src.slice(open, close);
  }
  if (listText === null) return null;
  const body = listText.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  if (!/^\s*(?:(["'`])[^"'`\\$]*\1\s*(?:,\s*|$))*$/.test(body)) return null;
  const items = [...body.matchAll(/(["'`])([^"'`\\$]*)\1/g)].map((m) => prefix + m[2] + suffix);
  return items.length ? items : null;
}

// A pure webpack async chunk is a single statement:
//   (globalThis.webpackChunkNAME = globalThis.webpackChunkNAME || []).push([[ids], {modules}]);
// optionally preceded by a license banner / "use strict" and followed only by a
// sourcemap pragma. Anything else before/after is real top-level code — that's an
// entry script, not a registration, and must not be loaded into the background.
const CHUNK_PREFIX_RE = /^(?:\uFEFF|\s|;|["']use strict["'];?|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/;
const CHUNK_SUFFIX_RE = /^(?:\s|;|\/\/[#@][^\n]*(?:\n|$)|\/\*[#@][\s\S]*?\*\/)*$/;

/**
 * Find every webpack async chunk belonging to the worker's bundle: the worker
 * declares a `webpackChunk*` loading global, and each chunk file starts with a push
 * into that SAME global (different bundles in the extension use different globals
 * or none). Only 2-element pushes ([chunkIds, modules]) qualify — a 3rd element is
 * webpack's runtime/startup callback, which the wrapped push EXECUTES, so loading
 * such a file would boot a foreign entry point inside the background. Registration
 * pushes only define modules; nothing runs until the worker require()s them.
 * They load ahead of the worker with the shim (see wireBackground), after it
 * without. Returns root-relative paths, sorted for a deterministic manifest.
 */
function collectWebpackChunks(dir: string, swPath: string, hoisted: Set<string>): string[] {
  let swSrc: string;
  try {
    swSrc = readFileSync(join(dir, swPath), "utf-8");
  } catch {
    return [];
  }
  const name = chunkLoadingGlobal(swSrc);
  if (!name) return [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ref = `(?:globalThis|self|window)\\s*(?:\\.\\s*${esc}|\\[\\s*["']${esc}["']\\s*\\])`;
  const pushRe = new RegExp(`\\(\\s*${ref}\\s*=\\s*${ref}\\s*\\|\\|\\s*\\[\\s*\\]\\s*\\)\\s*\\.push\\s*\\(`);

  const chunks: string[] = [];
  for (const abs of walkScripts(dir)) {
    const rel = relative(dir, abs).split("\\").join("/");
    if (rel === swPath || hoisted.has(rel)) continue;
    let src: string;
    try {
      src = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    // Scan the whole file, not a fixed head window: a third-party-license banner
    // can run to many KB. The push must still be the FIRST real statement —
    // CHUNK_PREFIX_RE rejects a match with any real code before it.
    const m = pushRe.exec(src);
    if (!m || !CHUNK_PREFIX_RE.test(src.slice(0, m.index))) continue;
    const open = m.index + m[0].length - 1; // the push's "("
    const end = matchBalancedParen(src, open);
    if (end < 0) continue;
    if (pushArrayElementCount(src.slice(open + 1, end - 1)) !== 2) continue;
    if (!CHUNK_SUFFIX_RE.test(src.slice(end))) continue;
    chunks.push(rel);
  }
  return chunks.sort();
}

// The chunk-loading global a webpack bundle declares, dot or bracket form:
// globalThis.webpackChunkfoo = ...
function chunkLoadingGlobal(src: string): string {
  const gm = /(?:globalThis|self|window)\s*(?:\.\s*(webpackChunk[$\w]*)|\[\s*["'](webpackChunk[^"'\\]*)["']\s*\])\s*=(?!=)/.exec(src);
  return (gm && (gm[1] || gm[2])) || "";
}

/**
 * The chunk-loading global of a classic worker that loads webpack chunks with
 * importScripts, for the shim to replay the chunks listed ahead of it. Empty
 * when there is none. Read before wireBackground neutralises the call.
 */
export function workerChunkGlobal(dir: string, manifest: Manifest): string {
  const bg = manifest.background;
  if (!bg || typeof bg !== "object" || Array.isArray(bg.scripts) || bg.type === "module") return "";
  const sw = typeof bg.service_worker === "string" ? bg.service_worker.replace(/^(?:\.?\/)+/, "") : "";
  if (!sw) return "";
  let src: string;
  try {
    src = readFileSync(join(dir, sw), "utf-8");
  } catch {
    return "";
  }
  return /\bimportScripts\s*\(/.test(src) ? chunkLoadingGlobal(src) : "";
}

/**
 * Given the text between push( and ), verify it is a single array literal and
 * count its top-level elements. Shares walkCode's lexing with matchBalancedParen,
 * tracking all bracket kinds so a comma only counts at the array's own level.
 * Returns -1 when the text isn't one bare array literal.
 */
function pushArrayElementCount(s: string): number {
  let start = 0;
  while (start < s.length && /\s/.test(s[start])) start++;
  if (s[start] !== "[") return -1;
  let depth = 0;
  let count = 1;
  const at = walkCode(s, start, (c) => {
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) return true; // closed the outer array
    } else if (c === "," && depth === 1) count++;
    return false;
  });
  if (at < 0) return -1;
  // Only trailing whitespace may follow the outer array.
  for (let j = at + 1; j < s.length; j++) if (!/\s/.test(s[j])) return -1;
  return count;
}
