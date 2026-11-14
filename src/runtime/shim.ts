import { writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, basename, resolve, isAbsolute, sep, posix } from "node:path";
import type { Manifest } from "../types.js";
import { RUNTIME_DIR } from "../paths.js";
import { NAME } from "../name.js";
import { walkScripts } from "../input/stage.js";
import { SHIMMED_PERMISSIONS, UNSUPPORTED_PERMISSIONS } from "../manifest/compat-data.js";

/** Name of the compat shim inside the staged add-on. */
export const SHIM_FILENAME = `${NAME}-compat-shim.js`;
/** The runtime source writeShim fills in. */
const SHIM_TEMPLATE = "firefox-compat-shim.js";
/** Spliced into the shim for --debug builds only; never staged on its own. */
const DEBUG_RING_FILENAME = "debug-ring.js";
/** Spliced into the shim for add-ons that use chrome.debugger; never staged on its own. */
const DEBUGGER_FILENAME = "cdp-emulation.js";
/** The sandbox page that runs Chrome pac_script configs for the proxy.settings emulation. */
export const PAC_PAGE = `${NAME}-pac.html`;
/** Its script, copied from src/runtime/pac-sandbox.js. */
const PAC_SCRIPT = `${NAME}-pac.js`;
const PAC_TEMPLATE = "pac-sandbox.js";

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
  /** The worker's webpack chunk-loading global, when its chunks load ahead of it (see wireBackground). */
  webpackChunkGlobal?: string;
  /** The Chrome manifest asks for userScripts, which Firefox only grants at runtime. */
  userScripts?: boolean;
  /** The Chrome manifest's permissions and optional_permissions, before the transform removes any. */
  declaredPermissions?: string[];
  /** The Chrome manifest's chrome_url_overrides.newtab: the add-on's own new tab page. */
  newTabPage?: string;
  /**
   * The Chrome manifest's externally_connectable.ids: the other extensions it
   * lets in, [] when the key has no ids. Undefined without the key, where
   * Chrome lets every extension in.
   */
  externalIds?: string[];
  /** The page bridge lets the add-on's pages frame sites (framedSites), with session rules of its own. */
  frameGrants?: boolean;
  /** The scripts of the manifest's content_scripts that run in the isolated world, root-relative. */
  contentScripts?: string[];
}

// Parts of the shim with side effects beyond defining a missing member are only
// emitted for an add-on that needs them: favicon support wraps fetch and watches
// <img> elements, the new tab fix wraps tabs.create, a background that claims
// to be a service worker changes what code testing for one does, and so do the
// service worker's `clients` and `registration` in the background and
// navigator.serviceWorker in the extension's pages; the background's Web Lock
// names are translated only for code that takes locks, and getManifest() gains
// the worker's script only for code that reads service_worker.
const FAVICON_REF_RE = /chrome:\/\/favicon|(?:^|[^\w$])_favicon\//m;
const OFFSCREEN_REF_RE = /\.\s*offscreen\b|\[\s*["']offscreen["']\s*\]/;
const NEW_TAB_REF_RE = /["'`]chrome:\/\/new-?tab(?:-page)?\/?["'`]/i;
const SHORTCUTS_REF_RE = /["'`]chrome:\/\/extensions\/(?:shortcuts|configureCommands)\/?["'`]/i;
const SW_SCOPE_REF_RE = /\bServiceWorkerGlobalScope\b/;
// The worker's clients (`self.clients`, `clients.matchAll(`, `const { clients } = self`),
// and its pages' navigator.serviceWorker: the two ends of one channel.
const SW_CLIENTS_REF_RE = /\b(?:self|globalThis)\s*\.\s*clients\b|\bclients\s*\.\s*(?:matchAll|get|openWindow|claim)\s*\(|\{[^{}]*\bclients\b[^{}]*\}\s*=\s*(?:self|globalThis)\b|\bnavigator\s*\.\s*serviceWorker\b/;
// The worker's own registration, read for members the stand-in provides. A bundle
// that reaches for pushManager picks web push when it finds a registration, and
// Firefox gives add-ons no Push API, so it must keep finding none.
const SW_REGISTRATION_REF_RE = /\b(?:self|globalThis)\s*\.\s*registration\s*(?:\?\.|\.)\s*(?:active|installing|waiting|scope|addEventListener|update|unregister)\b/;
const PUSH_MANAGER_REF_RE = /\.\s*pushManager\b/;
// The worker's lifecycle: install/activate listeners and handlers, and skipWaiting().
const SW_LIFECYCLE_REF_RE = /\bon(?:install|activate)\s*=(?!=)|\baddEventListener\s*\(\s*["'`](?:install|activate)["'`]|\bskipWaiting\b/;
// The worker's own state (`self.serviceWorker.state`), read through any alias
// of self, which minifiers introduce: `"activated" === a.serviceWorker.state`.
// A ServiceWorker object has no pushManager, so web push doesn't rule it out.
const SW_STATE_REF_RE = /\.\s*serviceWorker\s*(?:\?\.|\.)\s*state\b/;
const LOCKS_REF_RE = /\bnavigator\s*\.\s*locks\b/;
// The manifest's worker script read at runtime: bundles resolve it against their
// own location to decide whether they run in the background.
const SW_MANIFEST_REF_RE = /\bservice_worker\b/;
const PERMISSIONS_CALL_RE = /\bpermissions\s*\.\s*(?:contains|request|remove|getAll)\b/;
const EXTRA_HEADERS_RE = /["'`]extraHeaders["'`]/;
// Chrome's names for a request an extension blocked, or one aborted, that a
// bundle compares a webRequest error against.
const CHROME_NET_ERROR_RE = /net::ERR_(?:BLOCKED_BY_CLIENT|ABORTED)\b/;
// The MV2 menu context, which Firefox refuses from an MV3 add-on.
const BROWSER_ACTION_CONTEXT_RE = /["'`]browser_action["'`]/;
// A body read as JSON, whose objects a Firefox content script gets from the page's realm.
const BODY_JSON_RE = /\.\s*json\s*\(\s*\)/;
// The storage areas whose set the clone fallback wraps.
const STORAGE_AREA_RE = /\bstorage\s*\.\s*(?:local|sync|session)\b/;
// Chrome's proxy settings, which the shim emulates on proxy.onRequest.
const PROXY_SETTINGS_RE = /\bproxy\s*\.\s*settings\b/;
// Extension messaging, whose JSON fallback wraps sendMessage, ports and the
// message listeners.
const MESSAGING_RE = /\b(?:sendMessage|onMessage|onMessageExternal|onConnect|onConnectExternal)\b|\b(?:runtime|tabs)\s*\.\s*connect\s*\(/;
// Content scripts injected at runtime from files (scripting.executeScript,
// registerContentScripts and updateContentScripts, MV2 tabs.executeScript).
const INJECTS_FILES_RE = /\b(?:executeScript|registerContentScripts|updateContentScripts)\b/;
// Stylesheets inserted or removed at runtime (scripting and MV2 tabs).
const INJECTS_CSS_RE = /\b(?:insertCSS|removeCSS)\b/;
const DECLARATIVE_CONTENT_RE = /\bdeclarativeContent\b/;
// A worker's own localStorage or sessionStorage, which it doesn't have:
// `self.localStorage = polyfill`. The event page's are getter-only.
const STORAGE_GLOBAL_ASSIGN_RE = /\b(?:self|globalThis)\s*\.\s*(localStorage|sessionStorage)\s*=(?!=)/g;
// A CustomEvent the code makes itself, whose detail a content script may hand
// the page's world.
const CUSTOM_EVENT_RE = /\bnew\s+(?:[\w$]+\s*\.\s*)?CustomEvent\b|\binitCustomEvent\s*\(/;
// A member of MV2's browserAction read (`chrome.browserAction.onClicked`), which
// an MV3 bundle's Firefox branch does; not the name alone, which polyfill
// metadata and message keys carry.
const BROWSER_ACTION_MEMBER_RE = /\bbrowserAction\s*(?:\?\.|\.)\s*[A-Za-z_$]/;
// Methods Firefox only promises and Chrome calls back from (the shim's
// PROMISE_ONLY, userScripts aside), by name.
const PROMISE_ONLY_CALL_RE = /\.\s*(getBadgeTextColor|setBadgeTextColor|isEnabled|openPopup|setPopup|discard|ungroup)\b/g;
// storage.session.setAccessLevel: content scripts get the session area through
// the background (the shim's installContentSession).
const SESSION_ACCESS_RE = /\bsetAccessLevel\b/;
// A cookie store id, which a bundle's Firefox branch passes to tabs.create and
// the like; Firefox refuses even the default store from an add-on without the
// cookies permission.
const COOKIE_STORE_ID_RE = /\bcookieStoreId\b/;
// Chrome's frozen condition, which Firefox's tabs.query refuses.
const FROZEN_KEY_RE = /\bfrozen\s*:|["'`]frozen["'`]/;
// console's methods replaced, or console handed to code that may replace them
// (`Object.assign(console, …)`, `(function (c) { … })(console)`): in a content
// script the page's console only lets each be replaced once.
const CONSOLE_PATCH_RE = /\bconsole\s*(?:\.\s*[\w$]+|\[[^\]\n]{1,40}\])\s*=(?!=)|\b(?:assign|defineProperty|defineProperties)\s*\(\s*console\b|\(\s*console\s*\)/;
// The add-on's own ID read, and selector calls it can end up in unquoted: a
// Chrome ID is a CSS identifier, Firefox's gecko ID isn't.
const RUNTIME_ID_RE = /\bruntime\s*(?:\?\.|\.)\s*id\b/;
const SELECTOR_CALL_RE = /\b(?:querySelector(?:All)?|matches|closest|webkitMatchesSelector)\s*\(/;

// A listener added with a last argument that can be false: a falsy literal,
// which is what a Chrome build compiles `isFirefox && { … }` to, or an `&&`
// expression that isn't a conditional.
const ADD_LISTENER_RE = /\.\s*addListener\s*\(/g;
const FALSY_LITERAL_RE = /^(?:!\s*1|false|0|""|''|null|void\s+0)$/;

// Whether a call in `src` passes addListener a last argument that may be false.
function hasFalsyListenerArg(src: string): boolean {
  if (!src.includes("addListener")) return false;
  ADD_LISTENER_RE.lastIndex = 0;
  for (let m = ADD_LISTENER_RE.exec(src); m; m = ADD_LISTENER_RE.exec(src)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let lastComma = -1;
    let and = false;
    let conditional = false;
    const close = walkCode(src, open, (c, i) => {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) return true;
      } else if (depth === 1) {
        if (c === ",") {
          lastComma = i;
          and = conditional = false;
        } else if (c === "&" && src[i + 1] === "&") and = true;
        else if (c === "?" && src[i + 1] !== "?" && src[i + 1] !== "." && src[i - 1] !== "?") conditional = true;
      }
      return false;
    });
    if (close < 0) continue;
    if (lastComma < 0) continue;
    if (FALSY_LITERAL_RE.test(src.slice(lastComma + 1, close).trim()) || (and && !conditional)) return true;
  }
  return false;
}

interface Usage {
  favicon: boolean;
  offscreen: boolean;
  newTab: boolean;
  shortcutsPage: boolean;
  serviceWorkerScope: boolean;
  serviceWorkerClients: boolean;
  serviceWorkerRegistration: boolean;
  serviceWorkerState: boolean;
  pushManager: boolean;
  serviceWorkerLifecycle: boolean;
  serviceWorkerManifest: boolean;
  locks: boolean;
  permissions: boolean;
  extraHeaders: boolean;
  chromeNetErrors: boolean;
  browserActionContext: boolean;
  bodyJson: boolean;
  storage: boolean;
  proxySettings: boolean;
  messaging: boolean;
  customEvent: boolean;
  injectsFiles: boolean;
  injectsCss: boolean;
  declarativeContent: boolean;
  storageGlobalsAssigned: string[];
  falsyListenerArg: boolean;
  browserAction: boolean;
  promiseOnlyCalls: string[];
  sessionAccess: boolean;
  cookieStoreId: boolean;
  frozenKey: boolean;
  consolePatch: boolean;
  runtimeId: boolean;
  selectorCall: boolean;
  /** The add-on's Chrome ID is written into its code. */
  chromeIdLiteral: boolean;
}

function scanUsage(dir: string, chromeId = ""): Usage {
  const found: Usage = {
    favicon: false, offscreen: false, newTab: false, shortcutsPage: false, serviceWorkerScope: false,
    serviceWorkerClients: false, serviceWorkerRegistration: false, serviceWorkerState: false, pushManager: false, serviceWorkerManifest: false, serviceWorkerLifecycle: false, locks: false, permissions: false,
    extraHeaders: false, chromeNetErrors: false, browserActionContext: false, bodyJson: false, storage: false, proxySettings: false, messaging: false, customEvent: false, storageGlobalsAssigned: [], falsyListenerArg: false, injectsFiles: false, injectsCss: false, declarativeContent: false, browserAction: false, cookieStoreId: false, frozenKey: false, consolePatch: false,
    promiseOnlyCalls: [], sessionAccess: false, runtimeId: false, selectorCall: false, chromeIdLiteral: false,
  };
  const ownId = chromeId.toLowerCase();
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
      if (!found.shortcutsPage) found.shortcutsPage = SHORTCUTS_REF_RE.test(src);
      if (!found.serviceWorkerScope) found.serviceWorkerScope = SW_SCOPE_REF_RE.test(src);
      if (!found.serviceWorkerClients) found.serviceWorkerClients = SW_CLIENTS_REF_RE.test(src);
      if (!found.serviceWorkerRegistration) found.serviceWorkerRegistration = SW_REGISTRATION_REF_RE.test(src);
      if (!found.serviceWorkerState) found.serviceWorkerState = SW_STATE_REF_RE.test(src);
      if (!found.pushManager) found.pushManager = PUSH_MANAGER_REF_RE.test(src);
      if (!found.serviceWorkerLifecycle) found.serviceWorkerLifecycle = SW_LIFECYCLE_REF_RE.test(src);
      if (!found.serviceWorkerManifest) found.serviceWorkerManifest = SW_MANIFEST_REF_RE.test(src);
      if (!found.locks) found.locks = LOCKS_REF_RE.test(src);
      if (!found.permissions) found.permissions = PERMISSIONS_CALL_RE.test(src);
      if (!found.extraHeaders) found.extraHeaders = EXTRA_HEADERS_RE.test(src);
      if (!found.chromeNetErrors) found.chromeNetErrors = CHROME_NET_ERROR_RE.test(src);
      if (!found.browserActionContext) found.browserActionContext = BROWSER_ACTION_CONTEXT_RE.test(src);
      if (!found.bodyJson) found.bodyJson = BODY_JSON_RE.test(src);
      if (!found.storage) found.storage = STORAGE_AREA_RE.test(src);
      if (!found.proxySettings) found.proxySettings = PROXY_SETTINGS_RE.test(src);
      if (!found.messaging) found.messaging = MESSAGING_RE.test(src);
      if (!found.customEvent) found.customEvent = CUSTOM_EVENT_RE.test(src);
      if (!found.injectsFiles) found.injectsFiles = INJECTS_FILES_RE.test(src);
      if (!found.injectsCss) found.injectsCss = INJECTS_CSS_RE.test(src);
      if (!found.declarativeContent) found.declarativeContent = DECLARATIVE_CONTENT_RE.test(src);
      if (!found.sessionAccess) found.sessionAccess = SESSION_ACCESS_RE.test(src);
      for (const m of src.matchAll(STORAGE_GLOBAL_ASSIGN_RE)) {
        if (!found.storageGlobalsAssigned.includes(m[1])) found.storageGlobalsAssigned.push(m[1]);
      }
      for (const m of src.matchAll(PROMISE_ONLY_CALL_RE)) {
        if (!found.promiseOnlyCalls.includes(m[1])) found.promiseOnlyCalls.push(m[1]);
      }
      if (!found.falsyListenerArg) found.falsyListenerArg = hasFalsyListenerArg(src);
      if (!found.browserAction) found.browserAction = BROWSER_ACTION_MEMBER_RE.test(src);
      if (!found.cookieStoreId) found.cookieStoreId = COOKIE_STORE_ID_RE.test(src);
      if (!found.frozenKey) found.frozenKey = FROZEN_KEY_RE.test(src);
      if (!found.consolePatch) found.consolePatch = CONSOLE_PATCH_RE.test(src);
      if (!found.runtimeId) found.runtimeId = RUNTIME_ID_RE.test(src);
      if (!found.selectorCall) found.selectorCall = SELECTOR_CALL_RE.test(src);
      // The page bridge lavaduct writes holds the ID too; it isn't the add-on's code.
      if (!found.chromeIdLiteral && ownId) found.chromeIdLiteral = src.includes(ownId) && !basename(file).startsWith(`${NAME}-`);
    }
  }
  return found;
}

// A name a script declares with `function` or `var`, which at the top of a
// script makes it a property of the global, and a name read off window or self.
const DECLARED_NAME_RE = /(?<![\w$.])(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|var\s+([A-Za-z_$][\w$]*))/g;
const WINDOW_MEMBER_RE = /(?<![\w$.])(?:window|self)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g;

/**
 * The names the content scripts declare and also read off window or self. In
 * Chrome's isolated world window is the global, so `function f` is window.f; a
 * Firefox content script's window is an Xray to the page's, which doesn't have
 * it (the shim's installContentGlobals). A declaration inside a function is
 * collected too; the shim's accessor answers only what the global holds.
 */
function contentGlobalNames(dir: string, scripts: string[]): string[] {
  const root = resolve(dir);
  const declared = new Set<string>();
  const read = new Set<string>();
  for (const rel of new Set(scripts.map((s) => s.replace(/^(?:\.?\/)+/, "")))) {
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep) || basename(file) === SHIM_FILENAME) continue;
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(DECLARED_NAME_RE)) declared.add(m[1] ?? m[2]);
    for (const m of src.matchAll(WINDOW_MEMBER_RE)) read.add(m[1]);
  }
  return [...read].filter((name) => declared.has(name)).sort();
}

/**
 * What the shim answers in permissions.contains/request for each permission
 * Firefox doesn't know, where Firefox itself would throw: granted when the
 * Chrome manifest asked for it and the shim emulates its API, otherwise not.
 */
function permissionAnswers(declared: string[]): Record<string, boolean> {
  const asked = new Set(declared);
  const answers: Record<string, boolean> = {};
  for (const perm of Object.keys(UNSUPPORTED_PERMISSIONS)) answers[perm] = asked.has(perm) && SHIMMED_PERMISSIONS.has(perm);
  return answers;
}

function shimSource(dir: string, config: ShimConfig): string {
  const usage = scanUsage(dir, config.extensionId ?? "");
  // The config goes in as a JSON literal, so nothing from the manifest is ever
  // interpolated into code. JSON.stringify leaves U+2028/U+2029 raw, which are
  // line terminators inside a JS string literal; escape them.
  const sidePanelPath = (config.sidePanelPath ?? "").split(/[?#]/)[0].replace(/^\/+/, "");
  const json = JSON.stringify({
    // Chrome defines chrome.sidePanel only for an add-on that asks for the
    // permission; one that declares or sets a panel page gets it as well.
    sidePanel: (config.declaredPermissions ?? []).includes("sidePanel") || sidePanelPath !== "",
    sidePanelPath,
    noDefaultPanel: config.noDefaultPanel === true,
    panelQuery: (config.panelQuery ?? "").replace(/^\?/, ""),
    extensionId: config.extensionId ?? "",
    favicon: usage.favicon,
    offscreen: usage.offscreen,
    newTab: usage.newTab,
    // The add-on's own new tab page, which chrome://newtab shows in Chrome.
    newTabPage: usage.newTab ? (config.newTabPage ?? "").split(/[?#]/)[0].replace(/^\/+/, "") : "",
    shortcutsPage: usage.shortcutsPage,
    externalIds: Array.isArray(config.externalIds) ? config.externalIds.filter((id) => typeof id === "string") : null,
    injectShim: usage.injectsFiles ? SHIM_FILENAME : "",
    // Relative paths in those calls and in insertCSS/removeCSS, which Firefox
    // resolves against the calling page and Chrome from the extension root.
    rootInjectedPaths: usage.injectsFiles || usage.injectsCss,
    // Chrome defines declarativeContent only with the permission.
    declarativeContent: usage.declarativeContent && (config.declaredPermissions ?? []).includes("declarativeContent"),
    serviceWorkerScope: config.serviceWorker === true && usage.serviceWorkerScope,
    serviceWorkerScript: config.serviceWorker === true ? (config.serviceWorkerScript ?? "").replace(/^(?:\.?\/)+/, "") : "",
    serviceWorkerClients: config.serviceWorker === true && usage.serviceWorkerClients,
    serviceWorkerController: config.serviceWorker === true && usage.serviceWorkerClients && !workerHandlesFetch(dir, config.serviceWorkerScript ?? ""),
    serviceWorkerRegistration: config.serviceWorker === true && usage.serviceWorkerRegistration && !usage.pushManager,
    serviceWorkerLifecycle: config.serviceWorker === true && usage.serviceWorkerLifecycle,
    serviceWorkerSelf: config.serviceWorker === true && (usage.serviceWorkerState || (usage.serviceWorkerRegistration && !usage.pushManager)),
    serviceWorkerLocks: config.serviceWorker === true && usage.locks,
    serviceWorkerManifest: config.serviceWorker === true && usage.serviceWorkerManifest,
    // lavaduct adds session rules of its own: the backend Origin rule, and the
    // frame grants' rules.
    reservedSessionRules: !!config.extensionId || config.frameGrants === true,
    userScriptEvents: config.userScripts === true,
    webpackChunkGlobal: config.webpackChunkGlobal ?? "",
    permissionAnswers: usage.permissions ? permissionAnswers(config.declaredPermissions ?? []) : null,
    extraHeaders: usage.extraHeaders,
    webRequestErrorNames: usage.chromeNetErrors,
    menuActionContext: usage.browserActionContext,
    contentBodyJson: usage.bodyJson,
    storageClone: usage.storage,
    proxySettings: usage.proxySettings,
    pacPage: usage.proxySettings ? PAC_PAGE : "",
    messageJson: usage.messaging,
    pageEventDetail: usage.customEvent,
    ownIdSelectors: usage.runtimeId && usage.selectorCall,
    storageGlobalsAssigned: config.serviceWorker === true ? usage.storageGlobalsAssigned.sort() : [],
    falsyListenerArgs: usage.falsyListenerArg,
    browserActionAlias: usage.browserAction,
    promiseOnlyCalls: usage.promiseOnlyCalls.sort(),
    sessionAccess: usage.sessionAccess,
    defaultCookieStore: usage.cookieStoreId,
    ownIdMessages: usage.chromeIdLiteral,
    tabsQueryFrozen: usage.frozenKey,
    contentConsole: usage.consolePatch,
    contentGlobals: contentGlobalNames(dir, config.contentScripts ?? []),
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

/** Whether the add-on's code uses Chrome's proxy.settings, which the shim emulates. */
export function usesProxySettings(dir: string): boolean {
  return scanUsage(dir).proxySettings;
}

/**
 * Stage the sandbox page the proxy.settings emulation runs PAC scripts in, and
 * declare it. A PAC script is code, and Firefox lets an add-on compile code only
 * in a manifest sandbox page whose CSP allows eval: Chrome's default sandbox CSP
 * is written when the manifest has no sandbox policy. An add-on's own sandbox
 * policy is kept as it is; if it forbids eval, PAC scripts fail and requests go
 * direct (or nowhere, with pacScript.mandatory), with the reason in the debug log.
 */
export function writePacSandbox(dir: string, manifest: Manifest, sandboxCsp: string): void {
  writeFileSync(join(dir, PAC_SCRIPT), readFileSync(join(RUNTIME_DIR, PAC_TEMPLATE), "utf-8"));
  writeFileSync(join(dir, PAC_PAGE), `<!doctype html>\n<meta charset="utf-8">\n<script src="${PAC_SCRIPT}"></script>\n`);
  const sandbox: { pages?: string[]; content_security_policy?: string } = { ...(manifest.sandbox ?? {}) };
  const pages = Array.isArray(sandbox.pages) ? sandbox.pages.filter((p): p is string => typeof p === "string") : [];
  if (!pages.includes(PAC_PAGE)) pages.push(PAC_PAGE);
  sandbox.pages = pages;
  if ((manifest.manifest_version ?? 2) >= 3) {
    const csp = manifest.content_security_policy;
    const policy = typeof csp === "object" && csp !== null ? csp : {};
    if (typeof policy.sandbox !== "string") manifest.content_security_policy = { ...policy, sandbox: sandboxCsp };
  } else if (typeof sandbox.content_security_policy !== "string") {
    sandbox.content_security_policy = sandboxCsp;
  }
  manifest.sandbox = sandbox;
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
      const end = matchBalanced(src, at + 10);
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
  // The byte order mark only declares UTF-8 at the very start of the file.
  const bom = BOM_RE.exec(html)?.[0] ?? "";
  return bom + markup + "\n" + html.slice(bom.length);
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
 *
 * A file with no doctype, no `<html>`, `<head>` or `<body>` and no script of its
 * own is a fragment the add-on fetches and inserts with innerHTML, not a page
 * Firefox loads: a <script> put at its top would become the fragment's first
 * element in the add-on's DOM, and code that never runs anything needs no shim.
 */
const PAGE_MARKER_RE = /<!doctype\b|<(?:html|head|body|script)(?=[\s/>])/i;
export function injectShimIntoHtmlPages(dir: string, shimFile: string): number {
  const tag = `<script src="/${shimFile}"></script>`;
  let count = 0;
  for (const file of walkHtmlFiles(dir)) {
    const html = readFileSync(file, "latin1");
    if (html.includes(tag) || !PAGE_MARKER_RE.test(html)) continue;
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
  // A path that climbs out of the staged add-on names a file of the user's,
  // which must never be read or rewritten as part of it; Firefox refuses it anyway.
  if (!sw || !insideStage(dir, sw)) return { converted: false, hoisted: [] };

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
 * Lexing walk shared by matchBalanced and pushArrayElementCount so the two
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
 * Given the index of an opening "(", "[" or "{" in `src`, return the index just
 * PAST its matching closer, honoring nesting and skipping string/template/comment/
 * regex content (see walkCode). Returns -1 if no balanced close is found. A closer
 * inside a template interpolation still counts — interpolations are code.
 */
function matchBalanced(src: string, open: number): number {
  const opener = src[open];
  const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
  let depth = 0;
  const at = walkCode(src, open, (c) => {
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return true;
    }
    return false;
  });
  return at < 0 ? -1 : at + 1;
}

/** matchBalancedParen for a "{" (a block, an object, or the brace of a `${`). */
export function matchBalancedBrace(src: string, open: number): number {
  let depth = 0;
  const at = walkCode(src, open, (c) => {
    if (c === "{") depth++;
    else if (c === "}") {
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
// neutralized as "dynamic" with its code lost.
const GETURL_LITERAL_RE = /(?:[A-Za-z_$][\w$]*\s*\.\s*)*runtime\s*\.\s*getURL\s*\(\s*(["'`])([^"'`$\\]+)\1\s*\)/g;
function rootLiteralsFromGetURL(argList: string): string {
  return argList.replace(GETURL_LITERAL_RE, (_m, _q, lit: string) => JSON.stringify("/" + lit.replace(/^\/+/, "")));
}

/**
 * Replace every importScripts call in ONE file (see importScriptsCalls) with a
 * void-0 no-op and return the resolvable string-literal targets (root-relative,
 * existing on disk) plus whether any call had a runtime-computed argument.
 */
function neutralizeImportScripts(dir: string, rootRel: string, resolveDir: string): { targets: string[]; dynamic: boolean } {
  if (!insideStage(dir, rootRel)) return { targets: [], dynamic: false };
  const filePath = join(dir, rootRel);
  let src: string;
  try {
    src = readFileSync(filePath, "utf-8");
  } catch {
    return { targets: [], dynamic: false };
  }
  const calls = importScriptsCalls(src);
  if (calls.length === 0) return { targets: [], dynamic: false };

  const targets: string[] = [];
  let dynamic = false;
  let out = "";
  let last = 0;
  for (const call of calls) {
    if (call.dynamic) dynamic = true;
    for (const literal of call.literals) {
      // A leading "/" is the extension root; anything else is relative to the
      // worker's own dir. join() would glue a root-absolute literal onto the
      // worker's dir ("src" + "/src/lib/a.js"), a path that exists nowhere.
      const fromRoot = (literal.startsWith("/") ? literal.slice(1) : join(resolveDir, literal))
        .split("\\").join("/");
      // Unresolved, or not a file → no script entry; the call is still neutralised.
      if (insideStage(dir, fromRoot) && isFile(join(dir, fromRoot))) targets.push(fromRoot);
    }
    out += src.slice(last, call.start) + "void 0 /* importScripts hoisted to background.scripts */";
    last = call.end;
  }
  out += src.slice(last);

  // Write whenever ANY call was neutralised: an unresolved target must be
  // de-fanged too, or it throws on the undefined global.
  writeFileSync(filePath, out, "utf-8");
  return { targets, dynamic };
}

/** One importScripts call in a file: its span, the files it names, and whether it computes any. */
export interface ImportScriptsCall {
  /** Start of the call, receiver chain included. */
  start: number;
  /** Index just past its closing ")". */
  end: number;
  literals: string[];
  dynamic: boolean;
}

/**
 * Every importScripts call in `src`, in order, classified (getURL literals read as
 * root paths): a call by name, `importScripts.call(scope, …urls)`, and
 * `importScripts.apply(scope, urls)`. An apply whose list isn't an array literal is
 * resolved through the function forwarding its arguments (see forwardedTargets).
 * Shared with the analyzer.
 *
 * The end of each call comes from matchBalanced, not a `[^)]*` regex: an
 * argument can contain parens itself (webpack's `importScripts(o.p+o.u(t))`), and
 * cutting at the first ")" leaves a dangling one behind, a SyntaxError. The match
 * also takes any receiver chain ending in `.importScripts`, so `self.importScripts(…)`
 * (Workbox) or a bundler alias (`var g=self; g.importScripts(…)`) is one span;
 * leaving the receiver behind would emit `self.void 0`. A bare `importScripts(`
 * still matches via the leading `\b`.
 */
export function importScriptsCalls(src: string): ImportScriptsCall[] {
  const calls: ImportScriptsCall[] = [];
  if (!/\bimportScripts\s*(?:\.\s*(?:apply|call)\s*)?\(/.test(src)) return calls;
  const callOpenRe = /(?:([A-Za-z_$][\w$]*(?:\s*(?:\?\.\s*[\w$]+|\.\s*[\w$]+|\[[^\]]*\]))*)\s*(?:\?\.|\.)\s*)?\bimportScripts\s*(?:\.\s*(apply|call)\s*)?\(/g;
  for (let mm: RegExpExecArray | null; (mm = callOpenRe.exec(src)); ) {
    const openParen = mm.index + mm[0].length - 1; // index of the "(" itself
    const end = matchBalanced(src, openParen); // index just past the ")"
    if (end < 0) continue; // unbalanced (shouldn't happen in valid JS) → leave as-is
    callOpenRe.lastIndex = end; // continue scanning after the full call
    const inner = src.slice(openParen + 1, end - 1);
    let classified: { literals: string[]; dynamic: boolean };
    if (!mm[2]) {
      classified = importScriptsTargets(src, mm.index, rootLiteralsFromGetURL(inner));
    } else {
      // The first argument of call and apply is the scope, not a URL.
      const urls = splitTopLevelArgs(inner).slice(1).join(",");
      if (mm[2] === "call") classified = importScriptsTargets(src, mm.index, rootLiteralsFromGetURL(urls));
      else {
        const list = /^\s*\[([\s\S]*)\]\s*$/.exec(urls);
        classified = list && matchBalanced(urls, urls.indexOf("[")) === urls.lastIndexOf("]") + 1
          ? importScriptsTargets(src, mm.index, rootLiteralsFromGetURL(list[1]))
          : forwardedTargets(src, mm.index, mm[1] ?? "", urls);
      }
    }
    calls.push({ start: mm.index, end, ...classified });
  }
  return calls;
}

/** An identifier as a regex source: `$` is its only character with a meaning there. */
const identPattern = (name: string): string => name.replace(/\$/g, "\\$");

/**
 * The files a function that forwards its own arguments to importScripts loads:
 * Closure's safe importScripts (safevalues' workerGlobalScopeImportScripts),
 *   function Aa(a){a.importScripts.apply(a,G.apply(1,arguments).map(unwrap))}
 *   var Ba=y(["mustache.js"]); … Aa(self,za(Ba));
 * (Google Dictionary). The apply at `callAt` must sit in a named function whose
 * argument list feeds it; every reference to that name must be a call, so no
 * caller is out of sight; and each URL a call passes must come down to one string
 * literal (resolveUrlLiteral). When the receiver is the function's first parameter,
 * that argument is the scope, not a URL. Anything short of that is dynamic.
 */
function forwardedTargets(src: string, callAt: number, receiver: string, urls: string): { literals: string[]; dynamic: boolean } {
  const fn = enclosingFunction(src, callAt);
  const dynamic = { literals: [], dynamic: true };
  if (!fn) return dynamic;
  const fed = new RegExp(`(?<![\\w$.])(?:${["arguments", ...fn.params].map(identPattern).join("|")})(?![\\w$])`);
  if (!fed.test(urls)) return dynamic;
  const skipScope = fn.params[0] !== undefined && receiver.trim() === fn.params[0];

  const literals: string[] = [];
  let isDynamic = false;
  const refRe = new RegExp(`(?<![\\w$.])${identPattern(fn.name)}(?![\\w$])`, "g");
  for (let m: RegExpExecArray | null; (m = refRe.exec(src)); ) {
    if (m.index === fn.nameAt) continue;
    const open = /^\s*\(/.exec(src.slice(m.index + m[0].length, m.index + m[0].length + 64));
    if (!open) { isDynamic = true; continue; }
    const openParen = m.index + m[0].length + open[0].length - 1;
    const end = matchBalanced(src, openParen);
    if (end < 0) { isDynamic = true; continue; }
    const args = splitTopLevelArgs(rootLiteralsFromGetURL(src.slice(openParen + 1, end - 1)));
    for (const arg of skipScope ? args.slice(1) : args) {
      const found = resolveUrlLiteral(src, arg, 0);
      if (found?.length === 1) literals.push(found[0]);
      else isDynamic = true;
    }
  }
  return { literals, dynamic: isDynamic };
}

/**
 * The innermost named function whose braced body contains `at`: `function f(…){`,
 * `f=function(…){` or `f=(…)=>{`. A method (`o.f=function`, `{f:function}`) has no
 * name here: its callers go through the object, out of sight of a scan for `f(`.
 * Heads are scanned forward and a body that ends before `at` is skipped whole, so
 * a big bundle is read about once.
 */
function enclosingFunction(src: string, at: number): { name: string; nameAt: number; params: string[] } | null {
  const headRe = /(?:(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*)?(?:\bfunction\b\s*([A-Za-z_$][\w$]*)?\s*\(([^()]*)\)|\(([^()]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)\s*\{/g;
  let best: { name: string; nameAt: number; params: string[] } | null = null;
  for (let m: RegExpExecArray | null; (m = headRe.exec(src)) && m.index < at; ) {
    const brace = m.index + m[0].length - 1;
    if (brace >= at) break;
    const end = matchBalanced(src, brace);
    if (end < 0) return best;
    if (end <= at) { headRe.lastIndex = end; continue; }
    // Callers use the name it is assigned to (`var Aa=function Ab(a){…}`). A name
    // of its own counts only for a declaration, at the start of a statement: an
    // expression's name (`o.f=function Ab(a){…}`) is visible inside it alone.
    const declared = m[1] === undefined && m[2] !== undefined && /(?:^|[;{}\n]|\*\/)\s*$/.test(src.slice(Math.max(0, m.index - 64), m.index));
    const name = m[1] ?? (declared ? m[2] : undefined);
    const nameAt = m[1] !== undefined ? m.index : src.indexOf(m[2], m.index + 8);
    const params = (m[3] ?? m[4] ?? m[5] ?? "").split(",").map((p) => p.replace(/^\s*\.\.\./, "").replace(/=[\s\S]*$/, "").trim()).filter(Boolean);
    best = name ? { name, nameAt, params } : null;
    headRe.lastIndex = brace + 1;
  }
  return best;
}

/**
 * The string literals an expression comes down to, read without running it: a
 * literal; an interpolation-free template, tagged or not; an array literal; a
 * variable assigned exactly once in the file (its initializer); or a call, through
 * its arguments, which sees through the template-tag and TrustedResourceUrl
 * wrappers Closure puts around a URL (`za(y(["mustache.js"]))`). Null when any
 * part is anything else. A caller wanting one URL needs exactly one literal back:
 * a template with an interpolation gives two pieces and so names nothing.
 */
function resolveUrlLiteral(src: string, expr: string, depth: number): string[] | null {
  const e = expr.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!e || depth > 6) return null;
  const whole = /^"([^"\\]*)"$|^'([^'\\]*)'$|^(?:[A-Za-z_$][\w$.]*\s*)?`((?:[^`$\\]|\$(?!\{))*)`$/.exec(e);
  if (whole) return [whole[1] ?? whole[2] ?? whole[3]];
  if (e.startsWith("[") && matchBalanced(e, 0) === e.length) return resolveAll(src, e.slice(1, -1), depth);
  const call = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/.exec(e);
  if (call && matchBalanced(e, call[0].length - 1) === e.length) return resolveAll(src, e.slice(call[0].length, -1), depth);
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const init = soleInitializer(src, e);
    return init === null ? null : resolveUrlLiteral(src, init, depth + 1);
  }
  return null;
}

function resolveAll(src: string, list: string, depth: number): string[] | null {
  const out: string[] = [];
  for (const item of splitTopLevelArgs(list)) {
    if (!item.trim()) continue;
    const found = resolveUrlLiteral(src, item, depth + 1);
    if (!found) return null;
    out.push(...found);
  }
  return out;
}

/**
 * The expression assigned to `name`, when the file assigns it exactly once
 * (`var Ba=…`, `,Ba=…` or `Ba=…`) and never updates it in place. Null otherwise.
 */
function soleInitializer(src: string, name: string): string | null {
  const n = identPattern(name);
  if (new RegExp(`(?<![\\w$.])${n}\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|\\?\\?|&&|\\|\\|)=|(?:\\+\\+|--)\\s*${n}(?![\\w$])|(?<![\\w$.])${n}\\s*(?:\\+\\+|--)`).test(src)) return null;
  const assigns = [...src.matchAll(new RegExp(`(?<![\\w$.])${n}\\s*=(?![=>])`, "g"))];
  if (assigns.length !== 1) return null;
  const start = assigns[0].index + assigns[0][0].length;
  // The initializer runs to the first top-level "," or ";", or a bracket closing
  // the statement it sits in.
  let depth = 0;
  const stop = walkCode(src, start, (c) => {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return true;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return true;
    return false;
  });
  return src.slice(start, stop < 0 ? src.length : stop);
}

/**
 * Classify one importScripts call's arguments (getURL literals already rewritten):
 * the file names it statically imports, and whether any argument is computed at
 * runtime. A whole string literal names a file. A literal that is only part of an
 * expression names nothing (`importScripts('./' + script)` is not "./"); a loop
 * over a literal list is resolved instead.
 */
function importScriptsTargets(src: string, callAt: number, argList: string): { literals: string[]; dynamic: boolean } {
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

/** Whether a root-relative path stays inside the staged add-on (no `..` escape). */
function insideStage(dir: string, rootRel: string): boolean {
  const root = resolve(dir);
  const rel = relative(root, resolve(root, rootRel.replace(/^\/+/, "")));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

const FETCH_HANDLER_RE = /\bonfetch\s*=(?!=)|\baddEventListener\s*\(\s*["'`]fetch["'`]/;
const IMPORT_SCRIPTS_CALL_RE = /\bimportScripts\s*\(([^)]*)\)/g;
const STATIC_IMPORT_RE = /(?:^|[;\s}])(?:import|export)\s*(?:[\w$*{},\s]+?\s*from\s*)?["']([^"']+)["']/g;

/**
 * Whether the Chrome background worker handles `fetch`: its script or one it
 * pulls in with importScripts() or a static import sets onfetch or listens for
 * "fetch". Such a worker serves requests its pages make, which the event page
 * can't, so its pages mustn't be told they are controlled. Ported from
 * aqueduct's backgroundHandlesFetch. Paths come from the untrusted bundle, so
 * nothing outside the staged add-on is read.
 */
export function workerHandlesFetch(dir: string, worker: string): boolean {
  const entry = worker.replace(/^(?:\.?\/)+/, "");
  if (!entry) return false;
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0 && seen.size < 200) {
    const rel = queue.shift() as string;
    if (seen.has(rel) || !insideStage(dir, rel)) continue;
    seen.add(rel);
    let src: string;
    try {
      src = readFileSync(join(dir, rel), "utf-8");
    } catch {
      continue;
    }
    if (FETCH_HANDLER_RE.test(src)) return true;
    const refs: string[] = [];
    for (const m of src.matchAll(IMPORT_SCRIPTS_CALL_RE)) {
      for (const lit of rootLiteralsFromGetURL(m[1]).matchAll(/["'`]([^"'`]+)["'`]/g)) refs.push(lit[1]);
    }
    for (const m of src.matchAll(STATIC_IMPORT_RE)) refs.push(m[1]);
    for (const ref of refs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
      const next = ref.startsWith("/") ? ref.slice(1) : join(dirname(rel), ref).split(sep).join("/");
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
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
    const end = matchBalanced(src, open);
    if (end < 0) continue;
    if (pushArrayElementCount(src.slice(open + 1, end - 1)) !== 2) continue;
    if (!CHUNK_SUFFIX_RE.test(src.slice(end))) continue;
    chunks.push(rel);
  }
  const named = chunkFileTemplate(swSrc);
  if (!named) return chunks.sort();
  // The worker only ever loads what its filename function names, relative to its
  // own folder (webpack's automatic publicPath). The pages' build may share the
  // chunk global, and its chunks must stay out of the background.
  const base = posix.dirname(swPath);
  return chunks
    .filter((rel) => {
      const fromWorker = base === "." ? rel : posix.relative(base, rel);
      return !fromWorker.startsWith("../") && fromWorker.startsWith(named.prefix) && fromWorker.endsWith(named.suffix);
    })
    .sort();
}

/**
 * The fixed start and end of the file names a webpack worker's chunk filename
 * function returns, read from its text without running it:
 *   __webpack_require__.u = chunkId => "bg." + ({96: "vendors"}[chunkId] || chunkId) + ".bundle.js"
 * gives { prefix: "bg.", suffix: ".bundle.js" }. Null when there is no such
 * function or it isn't a plain concatenation.
 */
function chunkFileTemplate(swSrc: string): { prefix: string; suffix: string } | null {
  const m = /(?:^|[^\w$.])[\w$]+\.u\s*=\s*(?:function\s*\(\s*[\w$]+\s*\)\s*\{\s*return\s+|\(?\s*[\w$]+\s*\)?\s*=>\s*)/.exec(swSrc);
  if (!m) return null;
  // The body runs to the first `;`, `,` or closing bracket outside brackets and strings.
  const start = m.index + m[0].length;
  let depth = 0;
  let end = start;
  for (; end < swSrc.length; end++) {
    const c = swSrc[end];
    if (c === '"' || c === "'" || c === "`") {
      const close = swSrc.indexOf(c, end + 1);
      if (close < 0) return null;
      end = close;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if ((c === ";" || c === "," || c === "\n") && depth === 0) break;
  }
  const body = swSrc.slice(start, end).trim();
  if (!body.includes("+")) return null;
  const lit = String.raw`(["'])([^"'\\]*)\1`;
  const head = new RegExp(`^${lit}\\s*\\+`).exec(body);
  const tail = new RegExp(`\\+\\s*${lit}$`).exec(body);
  return { prefix: head ? head[2] : "", suffix: tail ? tail[2] : "" };
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
  if (!sw || !insideStage(dir, sw)) return "";
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
 * count its top-level elements. Shares walkCode's lexing with matchBalanced,
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
