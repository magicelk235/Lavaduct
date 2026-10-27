// Writes src/manifest/compat-generated.ts: for every extension API and permission that
// Chrome documents, the first Firefox desktop release that supports it, or null when
// Firefox has none. The data comes from @mdn/browser-compat-data; the Chrome side is the
// list of APIs and permissions in Chrome's reference docs, kept below.
//
// Run `npm run gen-compat` after updating the dev dependency and review the diff. The
// output depends only on the inputs, so an unchanged dependency regenerates the same file.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const bcd = createRequire(import.meta.url)("@mdn/browser-compat-data");

const OUT = new URL("../src/manifest/compat-generated.ts", import.meta.url);

// https://developer.chrome.com/docs/extensions/reference/api (updated 2026-09-11), plus
// browserAction and pageAction from the Manifest V2 reference.
const CHROME_NAMESPACES = [
  "accessibilityFeatures", "action", "alarms", "audio", "bookmarks", "browserAction",
  "browsingData", "certificateProvider", "commands", "contentSettings", "contextMenus",
  "cookies", "debugger", "declarativeContent", "declarativeNetRequest", "desktopCapture",
  "devtools.inspectedWindow", "devtools.network", "devtools.panels", "devtools.performance",
  "devtools.recorder", "dns", "documentScan", "dom", "downloads",
  "enterprise.deviceAttributes", "enterprise.hardwarePlatform", "enterprise.login",
  "enterprise.networkingAttributes", "enterprise.platformKeys", "events", "extension",
  "extensionTypes", "fileBrowserHandler", "fileSystemProvider", "fontSettings", "gcm",
  "history", "i18n", "identity", "idle", "input.ime", "instanceID", "loginState",
  "management", "mimeHandler", "notifications", "offscreen", "omnibox", "pageAction",
  "pageCapture", "permissions", "platformKeys", "power", "printerProvider", "printing",
  "printingMetrics", "privacy", "processes", "proxy", "publicSuffix", "readingList",
  "runtime", "scripting", "search", "sessions", "sidePanel", "storage", "system.cpu",
  "system.display", "system.memory", "system.storage", "systemLog", "tabCapture",
  "tabGroups", "tabs", "topSites", "tts", "ttsEngine", "types", "userScripts",
  "vpnProvider", "wallpaper", "webAuthenticationProxy", "webNavigation", "webRequest",
  "windows",
];

// Members Chrome documents that browser-compat-data doesn't list. Each was checked
// against Firefox's API schemas: absent, or declared there as unsupported.
const CHROME_MEMBERS_NOT_IN_BCD = [
  "browsingData.removeAppcache", "browsingData.removeCacheStorage",
  "browsingData.removeFileSystems", "browsingData.removeIndexedDB",
  "browsingData.removeServiceWorkers", "browsingData.removeWebSQL",
  "cookies.getPartitionKey",
  "devtools.panels.setThemeChangeHandler",
  "downloads.onDeterminingFilename", "downloads.setUiOptions",
  "identity.clearAllCachedAuthTokens", "identity.getAccounts", "identity.getAuthToken",
  "identity.getProfileUserInfo", "identity.onSignInChanged", "identity.removeCachedAuthToken",
  "idle.getAutoLockDelay",
  "management.createAppShortcut", "management.generateAppForLink",
  "management.installReplacementWebApp", "management.launchApp", "management.setLaunchType",
  "notifications.getPermissionLevel", "notifications.onPermissionLevelChanged",
  "notifications.onShowSettings",
  "permissions.addHostAccessRequest", "permissions.removeHostAccessRequest",
  "proxy.onProxyError",
  "runtime.onConnectNative", "runtime.onEnabled", "runtime.restart", "runtime.restartAfterDelay",
  "sessions.getDevices",
  "sidePanel.close", "sidePanel.onClosed",
  "tabs.createSplit", "tabs.unsplit",
  "webRequest.onActionIgnored",
];

// https://developer.chrome.com/docs/extensions/reference/permissions-list (updated
// 2026-09-09), plus webRequestAuthProvider from the webRequest reference.
const CHROME_PERMISSIONS = [
  "accessibilityFeatures.modify", "accessibilityFeatures.read", "activeTab", "alarms", "audio",
  "background", "bookmarks", "browsingData", "certificateProvider", "clipboardRead",
  "clipboardWrite", "contentSettings", "contextMenus", "cookies", "debugger",
  "declarativeContent", "declarativeNetRequest", "declarativeNetRequestFeedback",
  "declarativeNetRequestWithHostAccess", "desktopCapture", "dns", "documentScan", "downloads",
  "downloads.open", "downloads.ui", "enterprise.deviceAttributes", "enterprise.hardwarePlatform",
  "enterprise.networkingAttributes", "enterprise.platformKeys", "favicon", "fileBrowserHandler",
  "fileSystemProvider", "fontSettings", "gcm", "geolocation", "history", "identity",
  "identity.email", "idle", "loginState", "management", "nativeMessaging", "notifications",
  "offscreen", "pageCapture", "platformKeys", "power", "printerProvider", "printing",
  "printingMetrics", "privacy", "processes", "proxy", "publicSuffix", "readingList", "runtime",
  "scripting", "search", "sessions", "sidePanel", "storage", "system.cpu", "system.display",
  "system.memory", "system.storage", "tabCapture", "tabGroups", "tabs", "topSites", "tts",
  "ttsEngine", "unlimitedStorage", "userScripts", "vpnProvider", "wallpaper",
  "webAuthenticationProxy", "webNavigation", "webRequest", "webRequestAuthProvider",
  "webRequestBlocking",
];

const statements = (compat, browser) => [].concat(compat?.support?.[browser] ?? []);

// "≤50" means "50 or earlier"; 50 is the safe answer for a minimum-version check.
function releaseNumber(versionAdded) {
  if (typeof versionAdded !== "string" || versionAdded === "preview") return null;
  return versionAdded.replace(/^≤/, "");
}

function compareReleases(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// First Firefox release that shipped `name`. A feature Firefox still supports may have
// earlier statements that were later replaced (setUninstallURL's URL limit grew in 116),
// so the earliest release among all statements counts once one of them is current.
// Firefox serves contextMenus as an alias of menus: a statement names the alias through
// alternative_name, and a member without its own alias statement inherits the canonical
// one.
function firefoxRelease(compat, name, bcdName) {
  const usable = statements(compat, "firefox").filter((s) => !s.flags && !s.prefix);
  let matching = usable.filter((s) => (s.alternative_name ?? bcdName) === name);
  if (!matching.length && name !== bcdName) matching = usable.filter((s) => !s.alternative_name);
  if (!matching.some((s) => releaseNumber(s.version_added) && !s.version_removed)) return null;
  let first = null;
  for (const s of matching) {
    const v = releaseNumber(s.version_added);
    if (v && (first === null || compareReleases(v, first) < 0)) first = v;
  }
  return first;
}

const chromeHas = (compat) => statements(compat, "chrome").some((s) => !!s.version_added);

// Resolve a Chrome namespace to its browser-compat-data node, following aliases
// (Chrome's contextMenus is filed under Firefox's name, menus).
function findNamespace(chromeName) {
  const direct = chromeName.split(".").reduce((node, part) => node?.[part], bcd.webextensions.api);
  if (direct?.__compat) return { node: direct, bcdName: chromeName };
  for (const [bcdName, node] of Object.entries(bcd.webextensions.api)) {
    if (statements(node.__compat, "chrome").some((s) => s.alternative_name === chromeName)) {
      return { node, bcdName };
    }
  }
  return null;
}

// Callable members and constants. PascalCase entries are types, which code never
// dereferences on chrome.*.
const isMember = (key) => /^[a-z]/.test(key) || /^[A-Z][A-Z0-9_]*$/.test(key);

const apiSupport = {};
for (const ns of CHROME_NAMESPACES) {
  const found = findNamespace(ns);
  if (!found) {
    apiSupport[ns] = null;
    continue;
  }
  apiSupport[ns] = firefoxRelease(found.node.__compat, ns, found.bcdName);
  for (const [key, child] of Object.entries(found.node)) {
    if (key === "__compat" || !isMember(key) || !child.__compat) continue;
    if (CHROME_NAMESPACES.includes(`${ns}.${key}`) || !chromeHas(child.__compat)) continue;
    apiSupport[`${ns}.${key}`] = firefoxRelease(child.__compat, `${ns}.${key}`, `${found.bcdName}.${key}`);
  }
}
for (const member of CHROME_MEMBERS_NOT_IN_BCD) {
  if (!(member in apiSupport)) apiSupport[member] = null;
}

// A permission counts as supported from the first release that accepts it in either
// list: userScripts is optional-only in Firefox, and browser-compat-data files
// publicSuffix under optional_permissions alone. Which list Firefox wants it in is
// decided by hand in compat-data.ts.
const permissionSupport = {};
for (const perm of CHROME_PERMISSIONS) {
  const key = perm.replaceAll(".", "_");
  let first = null;
  for (const list of ["permissions", "optional_permissions"]) {
    const compat = bcd.webextensions.manifest[list][key]?.__compat;
    const v = compat ? firefoxRelease(compat, key, key) : null;
    if (v && (first === null || compareReleases(v, first) < 0)) first = v;
  }
  permissionSupport[perm] = first;
}

const render = (table) =>
  Object.keys(table)
    .sort()
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(table[k])},`)
    .join("\n");

const source = `// Generated by scripts/gen-compat.mjs from @mdn/browser-compat-data ${bcd.__meta.version}.
// Don't edit by hand; run \`npm run gen-compat\`.

/**
 * First Firefox desktop release with each extension API Chrome documents, keyed by the
 * dotted name under \`chrome.\` ("tabs.query"), or null when Firefox has no such API.
 */
export const FIREFOX_API_SUPPORT: Record<string, string | null> = {
${render(apiSupport)}
};

/**
 * First Firefox desktop release that accepts each permission Chrome documents, in
 * \`permissions\` or \`optional_permissions\`, or null when Firefox doesn't know it.
 */
export const FIREFOX_PERMISSION_SUPPORT: Record<string, string | null> = {
${render(permissionSupport)}
};
`;

writeFileSync(OUT, source);
console.log(
  `Wrote ${OUT.pathname}: ${Object.keys(apiSupport).length} APIs, ${Object.keys(permissionSupport).length} permissions.`,
);
