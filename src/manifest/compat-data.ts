import type { Issue } from "../types.js";
import { FIREFOX_API_SUPPORT, FIREFOX_PERMISSION_SUPPORT } from "./compat-generated.js";

// What the converter does about each Chrome permission and API Firefox lacks.
// compat-generated.ts records which ones Firefox supports and from which release; this
// file adds the decisions made by hand: what the runtime shim emulates, what gets
// stripped, and the advice the analyzer prints. The analyzer and the manifest transform
// both read these tables, so the report and the output agree.

// One dot-separated part of a Mozilla version: a number, then an optional string,
// number and remainder ("0a1" is 0, "a", 1, ""). nsVersionComparator's rules.
function versionPart(part: string | undefined): [number, string, number, string] {
  const m = /^(\d*)([^\d]*)(\d*)(.*)$/s.exec(part ?? "") as RegExpExecArray;
  return [Number.parseInt(m[1], 10) || 0, m[2], Number.parseInt(m[3], 10) || 0, m[4]];
}

// A part's string sorts before none at all: 161.0a1 comes before 161.0.
function compareVersionStrings(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  return a < b ? -1 : 1;
}

/**
 * Compare Firefox versions the way Firefox does (Services.vc.compare), so a Nightly
 * or Beta sorts before its release: `compareFirefoxVersions("161.0a1", "161.0") < 0`.
 */
export function compareFirefoxVersions(a: string, b: string): number {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [numA, strA, numC, extraA] = versionPart(pa[i]);
    const [numB, strB, numD, extraB] = versionPart(pb[i]);
    const d = numA - numB || compareVersionStrings(strA, strB) || numC - numD || compareVersionStrings(extraA, extraB);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Permissions Firefox only grants at install and ignores in optional_permissions
 * (PermissionNoPrompt, and declarativeNetRequest, which is a plain Permission, in
 * Firefox's manifest schemas). The transform moves them from optional_permissions to
 * permissions. Value: whether Firefox asks for the permission at install.
 * browser-compat-data still lists contextMenus as optional, which current Firefox drops.
 */
export const INSTALL_TIME_PERMISSIONS: Record<string, boolean> = {
  alarms: false,
  contextMenus: false,
  declarativeNetRequest: true,
  declarativeNetRequestWithHostAccess: false,
  dns: false,
  identity: false,
  storage: false,
  unlimitedStorage: false,
};

/**
 * Permissions Firefox only grants at runtime (OptionalOnlyPermission) and ignores in
 * permissions. The transform moves them to optional_permissions.
 */
export const OPTIONAL_ONLY_PERMISSIONS: Record<string, true> = { userScripts: true };

/**
 * Permissions that are removed (Firefox doesn't know them) while the runtime shim keeps
 * the feature working, so the report tags them shimmed instead of lost.
 */
export const SHIMMED_PERMISSIONS = new Set(["debugger", "favicon", "identity.email", "offscreen", "sidePanel"]);

const CHROMEOS_ONLY = "ChromeOS-only; Firefox has no equivalent.";

const PERMISSION_NOTES: Record<string, string> = {
  favicon: "The shim answers chrome://favicon/ and /_favicon/ URLs with the site's icon.",
  "identity.email": "The shim's identity.getProfileUserInfo reads the email from Google when the cached token's scopes include it.",
  offscreen: "The shim runs offscreen documents as hidden iframes in the background page, which has a DOM in Firefox.",
  sidePanel: "The side panel's page becomes Firefox's sidebar (sidebar_action), from side_panel or from the page the code passes to sidePanel.setOptions, and the shim maps chrome.sidePanel onto sidebarAction.",
  background: "Firefox can't start add-ons before the browser or keep them running after it quits; the background script itself is unaffected.",
  contentSettings: "Firefox has no per-site content settings for add-ons; privacy and browserSettings cover a few of the same switches.",
  debugger:
    "The shim emulates chrome.debugger for tabs: Runtime.evaluate (REPL mode included) and console events, " +
    "Input mouse, wheel and key events and insertText, Page screenshots (tabs.captureTab), navigation, dialogs and " +
    "lifecycle events, Network request events (webRequest), and some DOM, Target and Accessibility calls. It adds " +
    "scripting, tabs, webNavigation, webRequest and access to all sites. Input events are synthetic (isTrusted is " +
    "false, no user activation), pages whose CSP forbids eval can't be evaluated in, response bodies aren't " +
    "available, and cross-origin frames are only reached through Firefox's frame IDs.",
  declarativeContent: "Show the toolbar button per tab with action.enable()/disable() from tabs.onUpdated instead.",
  desktopCapture: "Capture the screen with navigator.mediaDevices.getDisplayMedia() from an extension page.",
  "downloads.ui": "Firefox doesn't let add-ons hide its downloads panel.",
  fontSettings: "Firefox exposes no font settings to add-ons.",
  gcm: "Firefox has no Google Cloud Messaging; use the web Push API from a page you host, or poll with chrome.alarms.",
  pageCapture: "Firefox can't save pages as MHTML for add-ons; serialize the page from a content script instead.",
  power: "Keep the screen on with the Screen Wake Lock API (navigator.wakeLock) from a visible extension page.",
  printerProvider: "Firefox add-ons can't provide printers.",
  processes: "Firefox has no processes API.",
  readingList: "Firefox has no reading list API.",
  runtime: "Firefox grants connectNative and sendNativeMessage through nativeMessaging; add that permission if the add-on talks to a native app.",
  tabCapture: "For a still image use tabs.captureVisibleTab(); for video, navigator.mediaDevices.getDisplayMedia() from an extension page.",
  tts: "Speak with the Web Speech API (speechSynthesis) from an extension page.",
  ttsEngine: "Firefox add-ons can't provide speech engines.",
  webAuthenticationProxy: "Firefox has no WebAuthn proxy API for add-ons.",
  ...Object.fromEntries(
    [
      "accessibilityFeatures.modify",
      "accessibilityFeatures.read",
      "system.cpu",
      "system.display",
      "system.memory",
      "system.storage",
    ].map((p) => [p, "Firefox exposes no system or accessibility settings to add-ons."]),
  ),
  ...Object.fromEntries(
    [
      "audio",
      "certificateProvider",
      "documentScan",
      "enterprise.deviceAttributes",
      "enterprise.hardwarePlatform",
      "enterprise.networkingAttributes",
      "enterprise.platformKeys",
      "fileBrowserHandler",
      "fileSystemProvider",
      "loginState",
      "platformKeys",
      "printing",
      "printingMetrics",
      "vpnProvider",
      "wallpaper",
    ].map((p) => [p, CHROMEOS_ONLY]),
  ),
};

/** Permissions Firefox doesn't know, which the transform removes. Value = remediation note. */
export const UNSUPPORTED_PERMISSIONS: Record<string, string> = Object.fromEntries(
  Object.entries(FIREFOX_PERMISSION_SUPPORT)
    .filter(([, since]) => since === null)
    .map(([perm]) => [perm, PERMISSION_NOTES[perm] ?? `Firefox has no "${perm}" permission, so the API it unlocks isn't available.`]),
);

type ApiNote = {
  severity: Issue["severity"];
  message: string;
  fix: string;
  shimmed?: boolean;
  /** First Firefox release with the API; the analyzer skips the entry when --min-firefox is at least this. */
  since?: string;
};

const SHIMMED_NAMESPACES: Record<string, true> = { debugger: true, offscreen: true, sidePanel: true };

// Everything the runtime shim defines, keyed like FIREFOX_API_SUPPORT.
const SHIMMED_APIS: Record<string, { message: string; fix: string }> = {
  debugger: {
    message: "chrome.debugger is emulated on scripting, tabs, webNavigation and webRequest; the DevTools protocol commands extensions drive tabs with work, as synthetic input in the page.",
    fix: "Input events are synthetic (isTrusted is false, popups they open are blocked), Runtime.evaluate fails on pages whose CSP forbids eval, and Network.getResponseBody isn't available.",
  },
  sidePanel: {
    message: "chrome.sidePanel is emulated on Firefox's sidebar (sidebarAction); the panel's page (side_panel, or the page passed to setOptions) becomes sidebar_action.",
    fix: "Firefox opens the sidebar only in response to a user action, so sidePanel.open() from a timer or a message handler is refused.",
  },
  offscreen: {
    message: "chrome.offscreen is emulated with a hidden iframe in the background page (createDocument, closeDocument, hasDocument, Reason).",
    fix: "No action needed; runtime.getContexts() doesn't list the document, so check it with offscreen.hasDocument().",
  },
  "identity.getAuthToken": {
    message: "identity.getAuthToken is emulated with identity.launchWebAuthFlow and the manifest's oauth2 client.",
    fix: "Allow Firefox's redirect URL for that OAuth client (for Google, http://127.0.0.1/mozoauth2/…); users sign in through a Firefox window instead of Chrome's account picker.",
  },
  "identity.removeCachedAuthToken": {
    message: "identity.removeCachedAuthToken is emulated over the shim's token cache.",
    fix: "No action needed.",
  },
  "identity.clearAllCachedAuthTokens": {
    message: "identity.clearAllCachedAuthTokens is emulated over the shim's token cache.",
    fix: "No action needed.",
  },
  "identity.getProfileUserInfo": {
    message: "identity.getProfileUserInfo is emulated from Google's userinfo endpoint, using a cached getAuthToken token.",
    fix: "It returns an empty email and id unless that token's scopes include email or profile.",
  },
  "identity.onSignInChanged": {
    message: "identity.onSignInChanged exists but never fires, because Firefox has no browser sign-in.",
    fix: "Don't rely on it to detect sign-out.",
  },
};

// Advice for APIs Firefox lacks, keyed like FIREFOX_API_SUPPORT. Members of a missing
// namespace are covered by the namespace's entry.
const API_FIXES: Record<string, string> = {
  contentSettings: PERMISSION_NOTES.contentSettings,
  declarativeContent: PERMISSION_NOTES.declarativeContent,
  desktopCapture: PERMISSION_NOTES.desktopCapture,
  "devtools.performance": "Firefox's devtools has no hooks into its Performance panel.",
  "devtools.recorder": "Firefox's devtools has no Recorder panel.",
  dom: "In content scripts Firefox offers element.openOrClosedShadowRoot() directly.",
  fontSettings: PERMISSION_NOTES.fontSettings,
  gcm: PERMISSION_NOTES.gcm,
  instanceID: PERMISSION_NOTES.gcm,
  mimeHandler: "Firefox can't hand a MIME type to an add-on; webRequest.filterResponseData() can rewrite responses instead.",
  pageCapture: PERMISSION_NOTES.pageCapture,
  power: PERMISSION_NOTES.power,
  printerProvider: PERMISSION_NOTES.printerProvider,
  processes: PERMISSION_NOTES.processes,
  readingList: PERMISSION_NOTES.readingList,
  tabCapture: PERMISSION_NOTES.tabCapture,
  tts: PERMISSION_NOTES.tts,
  ttsEngine: PERMISSION_NOTES.ttsEngine,
  webAuthenticationProxy: PERMISSION_NOTES.webAuthenticationProxy,
  "browsingData.removeAppcache": "Call browsingData.remove() with the data types Firefox supports.",
  "browsingData.removeCacheStorage": "Call browsingData.remove() with the data types Firefox supports.",
  "browsingData.removeFileSystems": "Call browsingData.remove() with the data types Firefox supports.",
  "browsingData.removeIndexedDB": "Call browsingData.remove() with the data types Firefox supports.",
  "browsingData.removeServiceWorkers": "Call browsingData.remove() with the data types Firefox supports.",
  "browsingData.removeWebSQL": "Call browsingData.remove() with the data types Firefox supports.",
  "declarativeNetRequest.getMatchedRules": "Firefox doesn't report matched rules; declarativeNetRequest.testMatchOutcome() helps while developing.",
  "declarativeNetRequest.onRuleMatchedDebug": "Firefox doesn't report matched rules; declarativeNetRequest.testMatchOutcome() helps while developing.",
  "declarativeNetRequest.setExtensionActionOptions": "Firefox can't show matched-rule counts on the toolbar button.",
  "downloads.onDeterminingFilename": "Pass the filename to downloads.download() instead.",
  "downloads.setShelfEnabled": PERMISSION_NOTES["downloads.ui"],
  "downloads.setUiOptions": PERMISSION_NOTES["downloads.ui"],
  "extension.getExtensionTabs": 'Use extension.getViews({ type: "tab" }).',
  "extension.onRequest": "Use runtime.onMessage.",
  "extension.onRequestExternal": "Use runtime.onMessageExternal.",
  "extension.sendRequest": "Use runtime.sendMessage.",
  "identity.getAccounts": "Firefox has no list of signed-in browser accounts.",
  "management.uninstall": "Firefox only lets an add-on uninstall itself (management.uninstallSelf()).",
  "notifications.onButtonClicked": "Firefox notifications have no buttons; handle notifications.onClicked instead.",
  "notifications.update": "Clear the notification and create it again.",
  "proxy.onProxyError": "Listen to proxy.onError instead.",
  "runtime.onBrowserUpdateAvailable": "Firefox updates itself and its add-ons; there is nothing to watch for.",
  "runtime.requestUpdateCheck": "Firefox updates add-ons on its own schedule; there is nothing to check.",
  "runtime.onRestartRequired": "ChromeOS kiosk only.",
  "runtime.restart": "ChromeOS kiosk only.",
  "runtime.restartAfterDelay": "ChromeOS kiosk only.",
  "sessions.getDevices": "Firefox doesn't expose synced devices to add-ons.",
  "tabs.getAllInWindow": "Use tabs.query({ windowId }).",
  "tabs.getSelected": "Use tabs.query({ active: true, currentWindow: true }).",
  "tabs.onActiveChanged": "Listen to tabs.onActivated.",
  "tabs.onHighlightChanged": "Listen to tabs.onHighlighted.",
  "tabs.onReplaced": "Firefox doesn't replace tabs, so there is nothing to listen for.",
  "tabs.onSelectionChanged": "Listen to tabs.onActivated.",
  "tabs.sendRequest": "Use tabs.sendMessage.",
  "tabs.setZoomSettings": "Firefox doesn't let add-ons change zoom settings; tabs.setZoom() still works.",
  "windows.onBoundsChanged": "Listen for resize events in the window's pages, or poll windows.get().",
  ...Object.fromEntries(
    [
      "accessibilityFeatures",
      "system.cpu",
      "system.display",
      "system.memory",
      "system.storage",
    ].map((ns) => [ns, PERMISSION_NOTES["system.cpu"]]),
  ),
  ...Object.fromEntries(
    [
      "audio",
      "certificateProvider",
      "documentScan",
      "enterprise.deviceAttributes",
      "enterprise.hardwarePlatform",
      "enterprise.login",
      "enterprise.networkingAttributes",
      "enterprise.platformKeys",
      "fileBrowserHandler",
      "fileSystemProvider",
      "input.ime",
      "loginState",
      "platformKeys",
      "printing",
      "printingMetrics",
      "systemLog",
      "vpnProvider",
      "wallpaper",
      "management.createAppShortcut",
      "management.generateAppForLink",
      "management.installReplacementWebApp",
      "management.launchApp",
      "management.setLaunchType",
    ].map((name) => [name, name.startsWith("management.") ? "Chrome Apps only; Firefox has no equivalent." : CHROMEOS_ONLY]),
  ),
};

// Gaps that browser-compat-data can't express: APIs Firefox has with different
// semantics, and an argument value Firefox rejects.
const HAND_NOTES: Record<string, ApiNote> = {
  "chrome.identity.launchWebAuthFlow": {
    severity: "info",
    message: "identity.launchWebAuthFlow works in Firefox, but its redirect URL isn't Chrome's https://<id>.chromiumapp.org/.",
    fix: "Register the value of identity.getRedirectURL() in Firefox with the OAuth provider.",
  },
  "chrome.proxy.settings": {
    severity: "warning",
    message: "Firefox's proxy.settings takes a different config than Chrome's (proxyType/http/ssl/autoConfigUrl instead of mode/rules/pacScript), so Chrome-style configs are rejected.",
    fix: "Translate the config, or route requests with proxy.onRequest. Firefox also only allows proxy.settings when the user lets the add-on run in private windows.",
  },
  OFFSCREEN_DOCUMENT: {
    severity: "warning",
    message: 'runtime.getContexts() with contextTypes "OFFSCREEN_DOCUMENT" throws in Firefox, whose context types have no offscreen documents.',
    fix: "Ask chrome.offscreen.hasDocument() instead; the shim answers it.",
  },
};

// browser-compat-data marks these unsupported, but Firefox's API schemas define them,
// so using them doesn't throw. Value: what does differ, or null when nothing worth
// reporting does.
const DEFINED_BUT_LIMITED: Record<string, string | null> = {
  "devtools.panels.sources": null,
  "tabs.onReplaced": null,
  "notifications.onButtonClicked": "chrome.notifications.onButtonClicked exists in Firefox but never fires, because Firefox notifications have no buttons.",
  "tabs.setZoomSettings": "chrome.tabs.setZoomSettings exists in Firefox but throws unless the settings match the tab's current ones.",
};

// Firefox 109 is the first release with Manifest V3; minimum versions below it aren't
// tracked, which keeps gates on long-standing APIs out of the table.
const OLDEST_TRACKED_FIREFOX = "109";

// Nearest enclosing namespace that has its own entry: "devtools.panels" for
// "devtools.panels.create", none for "devtools.panels" or "system.cpu".
function parentApi(name: string): string | undefined {
  for (let i = name.lastIndexOf("."); i > 0; i = name.lastIndexOf(".", i - 1)) {
    const prefix = name.slice(0, i);
    if (Object.hasOwn(FIREFOX_API_SUPPORT, prefix)) return prefix;
  }
  return undefined;
}

// The analyzer matches keys as plain substrings, so "chrome.management.uninstall" would
// also fire on management.uninstallSelf. Keys that prefix another API name get a word
// boundary, which turns them into a regex.
const API_NAMES = Object.keys(FIREFOX_API_SUPPORT);
function apiKey(name: string): string {
  const prefixesAnother = API_NAMES.some((other) => other.length > name.length && other.startsWith(name) && /[\w$]/.test(other[name.length]));
  return `chrome.${name}${prefixesAnother ? "\\b" : ""}`;
}

function missingMessage(name: string, isNamespace: boolean): string {
  const leaf = name.slice(name.lastIndexOf(".") + 1);
  if (isNamespace) return `chrome.${name} doesn't exist in Firefox, so code that uses it throws.`;
  if (/^on[A-Z]/.test(leaf)) return `chrome.${name} doesn't exist in Firefox; adding a listener throws a TypeError.`;
  if (/^[A-Z][A-Z0-9_]*$/.test(leaf)) return `chrome.${name} is undefined in Firefox.`;
  return `chrome.${name} doesn't exist in Firefox; calling it throws a TypeError.`;
}

function buildApiTable(): Record<string, ApiNote> {
  const table: Record<string, ApiNote> = {};
  for (const [name, since] of Object.entries(FIREFOX_API_SUPPORT)) {
    const parent = parentApi(name);
    if (Object.hasOwn(SHIMMED_APIS, name) || (parent !== undefined && SHIMMED_NAMESPACES[parent] === true)) continue;
    if (since === null) {
      if (parent !== undefined && FIREFOX_API_SUPPORT[parent] === null) continue;
      const limited = Object.hasOwn(DEFINED_BUT_LIMITED, name) ? DEFINED_BUT_LIMITED[name] : undefined;
      if (limited === null) continue;
      table[apiKey(name)] = {
        severity: "warning",
        message: limited ?? missingMessage(name, parent === undefined),
        fix: API_FIXES[name] ?? `Feature-detect it (if (chrome.${name})) or drop the feature from the Firefox build.`,
      };
      continue;
    }
    if (compareFirefoxVersions(since, OLDEST_TRACKED_FIREFOX) <= 0) continue;
    const parentSince = parent === undefined ? null : FIREFOX_API_SUPPORT[parent];
    if (parentSince && compareFirefoxVersions(since, parentSince) <= 0) continue;
    table[apiKey(name)] = {
      severity: "warning",
      message: `chrome.${name} needs Firefox ${since}; older releases don't have it.`,
      fix: `Raise --min-firefox to ${since}, or feature-detect the API.`,
      since,
    };
  }
  for (const [name, note] of Object.entries(SHIMMED_APIS)) {
    table[apiKey(name)] = { severity: "info", ...note, shimmed: true };
  }
  return { ...table, ...HAND_NOTES };
}

/**
 * What the analyzer looks for in scripts. Keys are dotted chrome.* names (a `chrome.`
 * prefix also matches `browser.`) or a plain literal such as "OFFSCREEN_DOCUMENT"; a
 * key with `\b` is matched as a regex. `since` marks APIs Firefox gained after its
 * first Manifest V3 release; the entry doesn't apply when --min-firefox is at least that.
 */
export const UNSUPPORTED_APIS: Record<string, ApiNote> = buildApiTable();
