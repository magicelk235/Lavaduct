import { readdirSync, readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Issue, Manifest } from "../types.js";
import { parseJsonc, resolveI18nStringStrict } from "../manifest/manifest.js";
import { UNSUPPORTED_APIS } from "../manifest/compat-data.js";
import { matchBalancedParen, rootLiteralsFromGetURL, importScriptsTargets } from "../runtime/shim.js";

/**
 * Recursive file finder. Dirent-based so each entry costs no extra stat (only
 * symlinks are stat'ed to resolve their target kind); `seen` holds realpaths of
 * visited directories to break symlink cycles.
 */
function walkFiles(dir: string, exts: string[], acc: string[] = [], seen = new Set<string>()): string[] {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return acc;
  }
  if (seen.has(real)) return acc;
  seen.add(real);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const name = entry.name;
    // staged_extension is this tool's own output; scanning it duplicates every issue.
    if (name === "node_modules" || name === ".git" || name === "staged_extension" || name.startsWith("__MACOSX")) continue;
    const full = join(dir, name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) walkFiles(full, exts, acc, seen);
    else if (isFile && exts.some((e) => name.endsWith(e))) acc.push(full);
  }
  return acc;
}

/**
 * Lazy line resolver for one file: builds a newline-offset index on first use,
 * then answers each lookup with a binary search — instead of re-slicing and
 * splitting the whole content per match (quadratic on big bundled JS).
 */
function makeLineResolver(content: string): (index: number) => number {
  let offsets: number[] | null = null;
  return (index) => {
    if (!offsets) {
      offsets = [0];
      for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) offsets.push(i + 1);
      }
    }
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// Compile detection patterns once. Almost every key is a plain dotted name —
// after dot-escaping the regex matches a literal string, so indexOf (much
// faster than regex over the whole file) finds it directly. Only keys carrying
// real regex metachars (e.g. "chrome.tts\b") keep a compiled RegExp.
const API_PATTERNS = Object.entries(UNSUPPORTED_APIS).map(([api, info]) => {
  const name = api.replace(/\\b/g, "");
  if (api.includes("\\")) {
    // Widen a chrome. prefix to (?:chrome|browser). — polyfill code says browser.*.
    const source = api.replace(/\./g, "\\.").replace(/^chrome\\\./, "(?:chrome|browser)\\.");
    return { name, literal: null as string | null, re: new RegExp(source), info };
  }
  return { name, literal: api, re: null as RegExp | null, info };
});

// webextension-polyfill extensions write browser.identity etc. — probe both prefixes.
function indexOfApi(content: string, literal: string): number {
  const a = content.indexOf(literal);
  if (!literal.startsWith("chrome.")) return a;
  const b = content.indexOf("browser." + literal.slice("chrome.".length));
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}
// chrome://favicon/<url> and /_favicon/?pageUrl=… — the shim serves both for
// <img> and fetch.
const FAVICON_RE = /chrome:\/\/favicon|[/'"]_favicon\//;
// A hardcoded chrome-extension://<32-char-id>/ URL. Staging rewrites the scheme to
// moz-extension://, but Firefox gives every install its own random UUID, so the
// Chrome id in the host part never resolves. Match the 32-char a–p id form
// precisely to avoid flagging chrome-extension:// joined with a variable.
const HARDCODED_EXT_URL_RE = /chrome-extension:\/\/[a-p]{32}\b/;
// A chrome://<page> URL (extensions, settings, newtab, …). Add-ons can't open
// chrome:// pages in Firefox, and Firefox's own pages live under about:. The bare
// "chrome://" prefix used in restricted-URL checks has no host and doesn't match;
// favicon URLs are handled above.
const CHROME_PAGE_URL_RE = /chrome:\/\/(?!favicon\b)[a-z][\w-]*(?:\/[\w-]+)?/;
// Detect code that pulls a Chrome version token out of the UA string — the telltale
// of UA version sniffing (e.g. /Chrome\/(\d+)/, /Chrom(e|ium)\/([0-9]+)\./). We
// match two source signals: a `Chrome/` or `Chromium/` literal where the slash may
// be escaped (`Chrome\/` in a regex literal), and the `Chrom(e|ium)` regex
// alternation in bare or non-capturing form.
const UA_CHROME_SNIFF_RE = /Chrom(?:e|ium)\\?\/|Chrom\((?:\?:)?e\|ium\)/;
const TIMER_RE = /(setTimeout|setInterval)\s*\(/;
const BACKGROUND_FILE_RE = /(background|service[-_]?worker)/i;
// scripting.executeScript / registerContentScripts into the page's main world.
const MAIN_WORLD_RE = /\bworld\s*:\s*["']MAIN["']|ExecutionWorld\.MAIN\b/;
// First Firefox release that accepts world: "MAIN" in scripting and content scripts.
const MAIN_WORLD_MIN_FIREFOX = 128;

function majorVersion(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function scanJsContent(content: string, rel: string, issues: Issue[], isClassicServiceWorker: boolean): void {
  const lineAt = makeLineResolver(content);

  const hits: Array<{ name: string; at: number; info: (typeof API_PATTERNS)[number]["info"] }> = [];
  for (const { name, literal, re, info } of API_PATTERNS) {
    const at = literal !== null ? indexOfApi(content, literal) : re!.exec(content)?.index ?? -1;
    if (at >= 0) hits.push({ name, at, info });
  }
  for (const h of hits) {
    // A more specific match (chrome.identity.launchWebAuthFlow) subsumes the
    // generic namespace one (chrome.identity) — skip the duplicate.
    if (hits.some((o) => o !== h && o.name.startsWith(h.name + "."))) continue;
    issues.push({
      severity: h.info.severity,
      category: "api",
      message: h.info.message,
      file: rel,
      line: lineAt(h.at),
      fix: h.info.fix,
      shimmed: h.info.shimmed,
    });
  }

  // Chrome-version sniffing out of navigator.userAgent. Firefox's UA has no Chrome
  // token, so the match comes back null and whatever depends on it quietly breaks
  // (e.g. download URLs built from the sniffed version).
  const ua = UA_CHROME_SNIFF_RE.exec(content);
  if (ua) {
    issues.push({
      severity: "warning",
      category: "api",
      message: "navigator.userAgent Chrome-version sniff detected; Firefox's user agent has no Chrome token, so the match comes back empty.",
      file: rel,
      line: lineAt(ua.index),
      fix: "Feature-detect instead of parsing the user agent, or handle the Firefox token.",
    });
  }

  if (BACKGROUND_FILE_RE.test(rel)) {
    const m = TIMER_RE.exec(content);
    if (m) {
      issues.push({
        severity: "warning",
        category: "background",
        message: "setTimeout/setInterval are unreliable in Firefox's background event page, which unloads when idle and drops pending timers.",
        file: rel,
        line: lineAt(m.index),
        fix: "Use chrome.alarms for scheduled work; persist state to storage.local.",
      });
    }
  }

  // The converter turns a classic MV3 service worker into background.scripts, where
  // importScripts() is undefined. String-literal targets are hoisted into the
  // scripts array ahead of the worker and every call is neutralized, so static
  // calls are auto-fixed (info). Only dynamic args (a variable/expression that
  // can't be hoisted) lose their imported code and need a manual rewrite (warning).
  // Every call is neutralized, so a static first call must not mask later dynamic
  // ones (webpack/Workbox workers often do a static precache import first, then a
  // dynamic chunk-loader call).
  // Static means every arg is a string literal (runtime.getURL("x") counts as
  // "/x"), or a loop over a literal list of names; importScriptsTargets() hoists
  // both. Anything else — a variable, a concat (base + "a.js") — warns.
  // Only the manifest-declared worker is converted; importScripts in any other file
  // is a genuine web worker and keeps working. Module workers can't call
  // importScripts at all, so they're skipped.
  // Args are extracted with the same balanced-paren scan the converter uses
  // (matchBalancedParen); a [^)]* regex truncates at the first ")" inside an
  // argument (webpack's `importScripts(o.p+o.u(t))`) and misclassifies.
  const IS_OPEN_RE = /\bimportScripts\s*\(/g;
  let isFirstAt = -1;
  let isDynamicAt = -1;
  if (isClassicServiceWorker) for (let m; (m = IS_OPEN_RE.exec(content)); ) {
    if (isFirstAt === -1) isFirstAt = m.index;
    const end = matchBalancedParen(content, m.index + m[0].length - 1);
    if (end < 0) break;
    const argList = rootLiteralsFromGetURL(content.slice(m.index + m[0].length, end - 1));
    IS_OPEN_RE.lastIndex = end;
    if (argList.trim() !== "" && importScriptsTargets(content, m.index, argList).dynamic) {
      isDynamicAt = m.index;
      break;
    }
  }
  // A dynamic call that is webpack's worker chunk loader is handled: the converter
  // lists the bundle's async chunks in background.scripts (matching the
  // webpackChunk global), so r.e() finds them loaded and never calls importScripts.
  // Only a non-webpack dynamic call still means dead code after conversion.
  const WEBPACK_CHUNK_GLOBAL_RE = /(?:globalThis|self|window)\s*(?:\.\s*webpackChunk[$\w]*|\[\s*["']webpackChunk[^"'\\]*["']\s*\])\s*=(?!=)/;
  if (isFirstAt !== -1) {
    issues.push(isDynamicAt !== -1 ? (WEBPACK_CHUNK_GLOBAL_RE.test(content) ? {
      severity: "info",
      category: "background",
      message: "Dynamic importScripts() is webpack's worker chunk loader; the bundle's async chunks are listed in background.scripts so chunk loading keeps working.",
      file: rel,
      line: lineAt(isDynamicAt),
    } : {
      severity: "warning",
      category: "background",
      message: "importScripts() with a dynamic (non-literal) argument can't be hoisted; the imported code won't run in Firefox's background scripts.",
      file: rel,
      line: lineAt(isDynamicAt),
      fix: 'Replace the dynamic importScripts(expr) with static imports (import "./a.js";) and declare the worker as a module.',
    }) : {
      severity: "info",
      category: "background",
      message: "importScripts() targets are auto-hoisted into background.scripts; the calls are neutralized.",
      file: rel,
      line: lineAt(isFirstAt),
    });
  }
}

/**
 * Single-pass source scan: walks the extension once, reads each file once, and
 * runs every disk-backed check (missing manifest files, _locales consistency,
 * chrome.* APIs Firefox lacks, background timers and importScripts, favicon
 * access, hardcoded extension and chrome:// URLs, main-world scripting).
 */
export function scanExtension(extPath: string, manifest: Manifest, opts: { minFirefox: string }): Issue[] {
  const issues: Issue[] = [];

  // Declared icon paths that don't exist on disk → Firefox shows a blank icon and
  // AMO validation rejects the package. Collect every referenced icon path from
  // manifest.icons and each action's default_icon, then flag the missing ones.
  // Web-accessible/CSS icons aren't checked — only manifest-declared.
  const iconPaths = new Set<string>();
  for (const p of Object.values(manifest.icons ?? {})) {
    if (typeof p === "string") iconPaths.add(p);
  }
  for (const a of [manifest.action, manifest.browser_action, manifest.page_action]) {
    const di = (a as { default_icon?: unknown } | undefined)?.default_icon;
    if (typeof di === "string") iconPaths.add(di);
    else if (di && typeof di === "object") {
      for (const p of Object.values(di as Record<string, unknown>)) {
        if (typeof p === "string") iconPaths.add(p);
      }
    }
  }
  for (const p of iconPaths) {
    if (!existsSync(join(extPath, p))) {
      issues.push({
        severity: "error",
        category: "icons",
        message: `Declared icon "${p}" is missing from the package; Firefox shows a blank icon and AMO validation rejects it.`,
        file: "manifest.json",
        fix: "Add the icon file, or remove the reference from manifest.json.",
      });
    }
  }

  // Manifest-referenced files that don't exist on disk → the content script or page
  // never runs, and AMO validation rejects the package. Collected as {path → where}
  // so a missing file is reported once with a useful location. Only author-declared
  // paths are checked here (analyze runs on the raw manifest, before the converter
  // injects its own shim/bridge scripts — so no false positives on those).
  const refs = new Map<string, string>();
  const addRef = (p: unknown, where: string) => {
    if (typeof p === "string" && p && !refs.has(p)) refs.set(p, where);
  };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  // arr()/typeof guards keep a malformed manifest (non-array js/scripts, etc.) from
  // crashing the scan — Chrome would reject it, but the converter should report.
  arr(manifest.content_scripts).forEach((cs: any, i) => {
    for (const j of arr(cs?.js)) addRef(j, `content_scripts[${i}].js`);
    for (const c of arr(cs?.css)) addRef(c, `content_scripts[${i}].css`);
  });
  for (const b of arr(manifest.background?.scripts)) addRef(b, "background.scripts");
  addRef(manifest.background?.service_worker, "background.service_worker");
  addRef(manifest.background?.page, "background.page");
  for (const a of [manifest.action, manifest.browser_action, manifest.page_action]) {
    addRef((a as { default_popup?: unknown } | undefined)?.default_popup, "action.default_popup");
  }
  addRef(manifest.side_panel?.default_path, "side_panel.default_path");
  addRef(manifest.options_page, "options_page");
  addRef(manifest.options_ui?.page, "options_ui.page");
  addRef(manifest.devtools_page, "devtools_page");
  for (const p of arr(manifest.sandbox?.pages)) addRef(p, "sandbox.pages");
  for (const [p, where] of refs) {
    // HTML page references may carry a #fragment or ?query (e.g.
    // "devpanel.html#popup"); the browser resolves those at load, so strip them
    // before checking the file on disk or a valid page reads as "missing".
    const filePart = p.split(/[#?]/)[0];
    if (!existsSync(join(extPath, filePart))) {
      issues.push({
        severity: "error",
        category: "manifest",
        message: `${where} references "${p}", which is missing from the package.`,
        file: "manifest.json",
        fix: "Firefox can't run a script or page that isn't in the package, and AMO validation rejects it; add the file or remove the reference.",
      });
    }
  }

  // _locales dir present but no default_locale → Firefox refuses to load the add-on.
  if (existsSync(join(extPath, "_locales")) && !manifest.default_locale) {
    issues.push({
      severity: "error",
      category: "i18n",
      message: "_locales/ is present but default_locale is missing; Firefox will refuse to load the add-on.",
      file: "manifest.json",
      fix: "Add a default_locale key matching one of your _locales subfolders.",
    });
  }

  // default_locale set → its _locales/<locale>/messages.json must exist and parse,
  // or the load fails with an opaque error.
  if (manifest.default_locale) {
    const msgs = join(extPath, "_locales", manifest.default_locale, "messages.json");
    if (!existsSync(msgs)) {
      issues.push({
        severity: "error",
        category: "i18n",
        message: `default_locale "${manifest.default_locale}" has no _locales/${manifest.default_locale}/messages.json.`,
        file: "manifest.json",
        fix: "Create the messages.json for the default locale, or change default_locale to an existing one.",
      });
    } else {
      try {
        parseJsonc(readFileSync(msgs, "utf-8"));
      } catch {
        issues.push({
          severity: "error",
          category: "i18n",
          message: `_locales/${manifest.default_locale}/messages.json is not valid JSON; the add-on will fail to load.`,
          file: `_locales/${manifest.default_locale}/messages.json`,
          fix: "Fix the JSON syntax.",
        });
      }
    }
  }

  // __MSG_key__ placeholders in name/description must resolve to a real message in
  // the default locale, or the add-on shows a broken name. Use the strict resolver:
  // manifest fields are localized from default_locale only, so a key that exists in
  // another locale but not the default one still fails, and the lenient
  // cross-locale resolver would hide that.
  for (const [field, raw] of [
    ["name", manifest.name],
    ["description", manifest.description],
  ] as const) {
    if (typeof raw === "string" && /^__MSG_.+__$/.test(raw)) {
      const resolved = resolveI18nStringStrict(raw, extPath, manifest.default_locale);
      if (resolved === undefined || resolved === raw) {
        issues.push({
          severity: "error",
          category: "i18n",
          message: `manifest.${field} uses "${raw}" but no matching message exists in the default locale; Firefox can't resolve it.`,
          file: "manifest.json",
          fix: `Add the "${raw.slice(6, -2)}" key to _locales/<default_locale>/messages.json, or use a plain string.`,
        });
      }
    }
  }

  // Manifest-relative path of a classic service worker: the one file the converter
  // rewrites, so the importScripts checks are gated to it.
  const swRel = typeof manifest.background?.service_worker === "string" && manifest.background.type !== "module"
    ? manifest.background.service_worker.replace(/^\.?\//, "")
    : undefined;
  const checkMainWorld = majorVersion(opts.minFirefox) < MAIN_WORLD_MIN_FIREFOX;

  let faviconNoted = false;
  let extUrlNoted = false;
  let chromeUrlNoted = false;
  let mainWorldNoted = !checkMainWorld;
  for (const file of walkFiles(extPath, [".js", ".mjs", ".html", ".css"])) {
    const isJs = file.endsWith(".js") || file.endsWith(".mjs");
    // html/css files are only read for the once-per-extension favicon,
    // hardcoded-extension-URL and chrome:// checks; skip them once all three have
    // been satisfied.
    if (!isJs && faviconNoted && extUrlNoted && chromeUrlNoted) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const rel = relative(extPath, file);
    // One lazy newline index per file, shared by all checks below (each builds its
    // offset table on first call, then reuses it).
    const lineAt = makeLineResolver(content);

    // Firefox has no favicon service for add-ons; the shim answers chrome://favicon
    // and _favicon URLs for <img> and fetch. One note is enough.
    if (!faviconNoted) {
      const m = FAVICON_RE.exec(content);
      if (m) {
        faviconNoted = true;
        issues.push({
          severity: "info",
          category: "api",
          message: "Favicon access via chrome://favicon / _favicon; the shim serves these URLs for <img> and fetch.",
          file: rel,
          line: lineAt(m.index),
          fix: "No action needed for images and fetch; a favicon URL used from CSS isn't covered.",
          shimmed: true,
        });
      }
    }

    // A hardcoded chrome-extension://<id>/ URL breaks under Firefox's per-install
    // UUID. One note is enough to surface the whole class.
    if (!extUrlNoted) {
      const m = HARDCODED_EXT_URL_RE.exec(content);
      if (m) {
        extUrlNoted = true;
        issues.push({
          severity: "warning",
          category: "api",
          message: "Hardcoded chrome-extension://<id> URL found; Firefox gives every install its own random moz-extension:// UUID, so it will not resolve.",
          file: rel,
          line: lineAt(m.index),
          fix: "Build extension URLs with chrome.runtime.getURL(path) instead of hardcoding the id.",
        });
      }
    }

    // A chrome://extensions/shortcuts, chrome://settings, … link. Firefox won't let
    // an add-on open chrome:// pages, so the navigation fails. One note covers the
    // class.
    if (!chromeUrlNoted) {
      const m = CHROME_PAGE_URL_RE.exec(content);
      if (m) {
        chromeUrlNoted = true;
        issues.push({
          severity: "warning",
          category: "api",
          message: `Link to "${m[0]}"; Firefox add-ons can't open chrome:// pages, so this navigation fails.`,
          file: rel,
          line: lineAt(m.index),
          fix: "For keyboard shortcuts call chrome.commands.openShortcutSettings() (Firefox 137+); otherwise tell users where the setting lives in Firefox instead of linking the chrome:// page.",
        });
      }
    }

    if (isJs && !mainWorldNoted) {
      const m = MAIN_WORLD_RE.exec(content);
      if (m) {
        mainWorldNoted = true;
        issues.push({
          severity: "warning",
          category: "api",
          message: `Script injection into the page's main world (world: "MAIN") needs Firefox ${MAIN_WORLD_MIN_FIREFOX}; the minimum Firefox version is ${opts.minFirefox}, where the call fails.`,
          file: rel,
          line: lineAt(m.index),
          fix: `Raise --min-firefox to ${MAIN_WORLD_MIN_FIREFOX} or later.`,
        });
      }
    }

    if (isJs) scanJsContent(content, rel, issues, rel.split("\\").join("/") === swRel);
  }

  return issues;
}
