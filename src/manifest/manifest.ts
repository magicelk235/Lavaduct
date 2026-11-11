import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, Issue, Platforms } from "../types.js";
import { NAME } from "../name.js";
import {
  INSTALL_TIME_PERMISSIONS,
  OPTIONAL_ONLY_PERMISSIONS,
  SHIMMED_PERMISSIONS,
  UNSUPPORTED_PERMISSIONS,
  compareFirefoxVersions,
} from "./compat-data.js";
import { FIREFOX_PERMISSION_SUPPORT } from "./compat-generated.js";

/**
 * Parse JSON that may carry // and /* *\/ comments or trailing commas — both are
 * illegal in strict JSON but common in hand-edited Chrome manifests (Chrome's own
 * loader tolerates comments). A single character-state scan skips comment runs and
 * trailing commas WITHOUT touching their look-alikes inside string literals (e.g.
 * the "//" in an "https://…" URL), then hands clean JSON to JSON.parse.
 */
export function parseJsonc<T = unknown>(text: string): T {
  // Strip a leading UTF-8 BOM (U+FEFF). Node's readFileSync('utf-8') leaves it in
  // place and it is none of "/,; so it survives the scan and makes JSON.parse throw
  // on the first char. BOMs are common in Windows-edited manifests / messages.json,
  // and Chrome's own loader tolerates them — match that.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n"; // preserve line numbering for parse errors
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // land on the '/', loop's i++ steps past it
      continue;
    }
    if (c === ",") {
      // Trailing comma? Peek past whitespace AND any comments; drop the comma when
      // the next significant character closes an object/array. Done in-scanner (not
      // a post-regex) so a "," inside a string literal is never affected.
      let j = i + 1;
      while (j < text.length) {
        const d = text[j];
        if (d === " " || d === "\t" || d === "\r" || d === "\n") j++;
        else if (d === "/" && text[j + 1] === "/") {
          j += 2;
          while (j < text.length && text[j] !== "\n") j++;
        } else if (d === "/" && text[j + 1] === "*") {
          j += 2;
          while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
          j += 2;
        } else break;
      }
      if (text[j] === "}" || text[j] === "]") continue; // skip trailing comma
    }
    out += c;
  }
  return JSON.parse(out) as T;
}

export function loadManifest(extPath: string): Manifest {
  const p = join(extPath, "manifest.json");
  if (!existsSync(p)) {
    // Name what IS there. Reports of this error are otherwise undebuggable: the
    // usual cause is an archive that holds something else — a store page saved as
    // .zip, a source tarball, an extension nested two levels deep, another archive
    // inside the archive — and the listing says which at a glance.
    let listing = "";
    try {
      const entries = readdirSync(extPath).filter((e) => e !== ".DS_Store" && e !== "__MACOSX");
      listing = entries.length
        ? `\n  It contains: ${entries.slice(0, 12).join(", ")}${entries.length > 12 ? `, … (${entries.length} entries)` : ""}`
        : "\n  It is empty.";
    } catch {}
    throw new Error(
      `No manifest.json found in ${extPath}.${listing}\n` +
        `  Point ${NAME} at the folder holding manifest.json, or at the .crx/.zip Chrome itself packed.`,
    );
  }
  return parseJsonc<Manifest>(readFileSync(p, "utf-8"));
}

/**
 * Resolve a __MSG_key__ manifest value from _locales. Chrome substitutes these
 * at load time; the converter needs the literal text to derive the add-on name and
 * output dir (otherwise they become "__MSG_extName___Firefox").
 * Lookup order: default_locale, English variants, then any locale present.
 * Message names are case-insensitive, matching Chrome. Returns the input
 * unchanged when it is not a __MSG_ reference; undefined when unresolvable.
 */
export function resolveI18nString(value: string | undefined, extPath: string, defaultLocale?: string): string | undefined {
  if (!value) return value;
  const ref = /^__MSG_(.+?)__$/.exec(value);
  if (!ref) return value;
  const key = ref[1].toLowerCase();
  const localesDir = join(extPath, "_locales");
  if (!existsSync(localesDir)) return undefined;
  let available: string[] = [];
  try {
    available = readdirSync(localesDir);
  } catch {
    return undefined;
  }
  const preferred = [defaultLocale, "en", "en_US", "en_GB"].filter((l): l is string => !!l);
  const seen = new Set<string>();
  for (const loc of [...preferred, ...available]) {
    if (seen.has(loc)) continue;
    seen.add(loc);
    const p = join(localesDir, loc, "messages.json");
    if (!existsSync(p)) continue;
    try {
      const msgs = parseJsonc<Record<string, { message?: string }>>(readFileSync(p, "utf-8"));
      for (const k of Object.keys(msgs)) {
        if (k.toLowerCase() === key) {
          const msg = msgs[k]?.message;
          if (typeof msg === "string" && msg.trim()) return msg.trim();
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Strict variant for the analyzer's placeholder check. Chrome substitutes manifest
 * __MSG_ placeholders ONLY from the default_locale's messages.json — it does NOT apply
 * the runtime UI-locale fallback to manifest fields. So a key present in en but missing
 * from default_locale 'de' is NOT substituted: Chrome renders the literal token.
 * resolveI18nString's broad cross-locale fallback would find the 'en' value and hide
 * that, so the analyzer must resolve against default_locale only. Returns the resolved
 * message, or undefined if the key is absent from the default locale (the real error
 * condition). The lenient resolveI18nString stays the right choice for deriving a
 * human label (a real name beats a literal token), but not for correctness checking.
 */
export function resolveI18nStringStrict(value: string | undefined, extPath: string, defaultLocale?: string): string | undefined {
  if (!value) return value;
  const ref = /^__MSG_(.+?)__$/.exec(value);
  if (!ref) return value;
  // No default_locale declared → Chrome can't localize the manifest at all; the token
  // stays literal, so treat as unresolved.
  if (!defaultLocale) return undefined;
  const key = ref[1].toLowerCase();
  const p = join(extPath, "_locales", defaultLocale, "messages.json");
  if (!existsSync(p)) return undefined;
  try {
    const msgs = parseJsonc<Record<string, { message?: string }>>(readFileSync(p, "utf-8"));
    for (const k of Object.keys(msgs)) {
      if (k.toLowerCase() === key) {
        const msg = msgs[k]?.message;
        if (typeof msg === "string" && msg.trim()) return msg.trim();
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * strict_min_version written when --min-firefox isn't given: the current ESR, so the
 * add-on installs on every Firefox release Mozilla still supports. Raise it at each new
 * ESR (175 arrives on 2027-06-29).
 */
export const DEFAULT_MIN_FIREFOX = "153.0";

/**
 * Turn a Chrome version string into one Firefox and AMO accept: one to four integers of
 * at most nine digits, without leading zeros. Each part keeps its leading digits, and
 * the first part with anything after them ends the version, so "1.2.3-beta.1" becomes
 * "1.2.3" rather than a "1.2.3.1" that sorts above the final release. Oversized parts
 * are clamped. A version with no leading number becomes "0.0.0".
 */
export function toFirefoxVersion(raw: string): string {
  const parts: string[] = [];
  for (const part of raw.trim().split(".")) {
    const digits = /^\d+/.exec(part)?.[0];
    if (digits === undefined) break;
    const n = digits.replace(/^0+(?=\d)/, "");
    parts.push(n.length > 9 ? "999999999" : n);
    if (digits.length < part.length || parts.length === 4) break;
  }
  return parts.length ? parts.join(".") : "0.0.0";
}

export interface ManifestAnalysis {
  issues: Issue[];
  permissionsToRemove: string[];
}

// Manifest values are parsed JSON, so a key typed as a list can hold anything.
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Check a match pattern against Firefox's manifest grammar (MatchPatternRestricted in
 * toolkit/components/extensions/schemas/manifest.json). Returns null when Firefox
 * accepts it, else a short reason.
 */
export function matchPatternError(pattern: string): string | null {
  if (pattern === "<all_urls>") return null;
  const m = /^([^:/]*):\/\/([^/]*)(.*)$/.exec(pattern);
  if (!m) return "not a scheme://host/path pattern";
  const [, scheme, host, path] = m;
  if (!/^(?:https?|wss?|ftp|file|\*)$/.test(scheme)) return `Firefox doesn't match "${scheme}:" URLs`;
  if (!path.startsWith("/")) return "missing path (a match pattern must end with a path, e.g. '/*')";
  if (host === "") return scheme === "file" ? null : "empty host";
  if (host === "*") return null;
  const body = host.startsWith("*.") ? host.slice(2) : host;
  if (body === "") return "empty host after '*.'";
  if (body.includes("*")) return `host "${host}" may only use '*' as the whole host or a leading '*.'`;
  return null;
}

// Chrome's port wildcard (host:*) isn't in Firefox's grammar, and a Firefox pattern
// without a port already matches every port, so dropping it keeps the pattern's
// meaning. Patterns are checked and written in this form.
const PORT_WILDCARD_RE = /^([^:/]*:\/\/[^/]*?):\*(?=\/)/;
export function withoutPortWildcard<T>(pattern: T): T {
  return (typeof pattern === "string" ? pattern.replace(PORT_WILDCARD_RE, "$1") : pattern) as T;
}

// web_accessible_resources match patterns Firefox refuses, such as Chrome's own
// chrome-extension://<id>/* origins.
function invalidResourceMatches(m: Manifest): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(m.web_accessible_resources) ? m.web_accessible_resources : []) {
    if (typeof entry !== "object" || entry === null || !("matches" in entry)) continue;
    for (const p of strings(entry.matches)) if (matchPatternError(withoutPortWildcard(p)) !== null) out.push(p);
  }
  return out;
}

// Firefox's ExtensionID (toolkit/components/extensions/schemas/manifest.json): a GUID
// in braces or name@domain. web_accessible_resources extension_ids also takes "*".
const FIREFOX_EXTENSION_ID_RE = /^(?:\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|[a-z0-9-._]*@[a-z0-9-._]+)$/i;
const resourceExtensionIdOk = (id: unknown): id is string => typeof id === "string" && (id === "*" || FIREFOX_EXTENSION_ID_RE.test(id));

// web_accessible_resources extension_ids Firefox refuses: Chrome's 32-letter IDs.
function invalidResourceExtensionIds(m: Manifest): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(m.web_accessible_resources) ? m.web_accessible_resources : []) {
    if (typeof entry !== "object" || entry === null || !("extension_ids" in entry)) continue;
    for (const id of strings(entry.extension_ids)) if (!resourceExtensionIdOk(id)) out.push(id);
  }
  return out;
}

// A search engine icon given as a web address, which Firefox's Manifest V3 refuses
// (favicon_url is a strictRelativeUrl there).
function remoteSearchFavicon(m: Manifest): string | null {
  if ((m.manifest_version ?? 2) < 3) return null;
  const overrides = m.chrome_settings_overrides;
  const provider = typeof overrides === "object" && overrides !== null && "search_provider" in overrides ? overrides.search_provider : undefined;
  const icon = typeof provider === "object" && provider !== null && "favicon_url" in provider ? provider.favicon_url : undefined;
  if (typeof icon !== "string") return null;
  return icon.startsWith("//") || URL.canParse(icon) ? icon : null;
}

// Firefox takes a search engine only from https:// or a local http:// address
// (search_url and suggest_url patterns in chrome_settings_overrides.json) and refuses
// the whole manifest otherwise; Chrome also takes http://. A __MSG_ value is checked
// after Firefox localizes it, which needs the locale files, so it is left alone.
const SECURE_SEARCH_URL_RE = /^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d*)?(?:\/|$))/;
function insecureSearchUrls(m: Manifest): Array<[string, string]> {
  const overrides = m.chrome_settings_overrides;
  const provider = typeof overrides === "object" && overrides !== null && "search_provider" in overrides ? overrides.search_provider : undefined;
  if (typeof provider !== "object" || provider === null) return [];
  const out: Array<[string, string]> = [];
  for (const key of ["search_url", "suggest_url"]) {
    const url: unknown = Reflect.get(provider, key);
    if (typeof url === "string" && url !== "" && !url.includes("__MSG_") && !SECURE_SEARCH_URL_RE.test(url)) out.push([key, url]);
  }
  return out;
}

// Firefox accepts a port in a pattern but compares it as part of the host name, so a
// pattern with a port never matches anything.
function portIssue(pattern: string, where: string, category: string): Issue | null {
  const port = /^[^:/]*:\/\/[^/]*?:(\d+)\//.exec(pattern)?.[1];
  if (port === undefined) return null;
  return {
    severity: "warning",
    category,
    message: `"${pattern}" in ${where} names port ${port}; Firefox never matches a pattern with a port.`,
    file: "manifest.json",
    fix: `Drop the port: "${pattern.replace(`:${port}/`, "/")}" matches every port in Firefox.`,
  };
}

// Firefox's rules for suggested_key (ShortcutUtils.validate in
// toolkit/modules/ShortcutUtils.sys.mjs). Ctrl and Command are the same modifier there.
const SHORTCUT_MODIFIERS: Record<string, string> = { Alt: "alt", Command: "accel", Ctrl: "accel", MacCtrl: "control", Shift: "shift" };
const MEDIA_KEY_RE = /^(?:MediaNextTrack|MediaPlayPause|MediaPrevTrack|MediaStop)$/;
const BASIC_KEY_RE = /^(?:[A-Z0-9]|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right)$/;
const FUNCTION_KEY_RE = /^(?:F[1-9]|F1[0-2])$/;
// Firefox validates these suggested_key platforms; chromeos, android and ios stay
// plain strings.
const VALIDATED_SHORTCUT_PLATFORMS = ["default", "mac", "linux", "windows"];

function shortcutError(chord: string): string | null {
  if (MEDIA_KEY_RE.test(chord.trim())) return null;
  const parts = chord.split("+").map((s) => s.trim());
  const key = parts.pop() ?? "";
  const unknown = parts.find((p) => !Object.hasOwn(SHORTCUT_MODIFIERS, p));
  if (unknown !== undefined) return `"${unknown}" isn't a modifier Firefox knows (Alt, Ctrl, Command, MacCtrl, Shift)`;
  const mods = parts.map((p) => SHORTCUT_MODIFIERS[p]);
  if (/^F1[3-9]$/.test(key)) return "F13 to F19 can only be assigned by the user";
  if (mods.length === 0 && !FUNCTION_KEY_RE.test(key)) return "it needs a Ctrl, Alt, Command or MacCtrl modifier";
  if (mods.length === 1 && mods[0] === "shift" && !FUNCTION_KEY_RE.test(key)) return "Shift alone isn't enough; add Ctrl, Alt, Command or MacCtrl";
  if (mods.length === 2 && mods[0] === mods[1]) return "it repeats a modifier (Firefox treats Ctrl and Command as one)";
  if (mods.length > 2) return "Firefox allows at most two modifiers";
  if (!BASIC_KEY_RE.test(key) && !FUNCTION_KEY_RE.test(key)) return `"${key}" isn't a key Firefox accepts in a shortcut`;
  return null;
}

// Every suggested_key chord of a command that Firefox would refuse, as
// [platform, chord, reason]. A string suggested_key is Chrome's shorthand for "default".
function invalidShortcuts(def: unknown): Array<[string, string, string]> {
  const suggested = typeof def === "object" && def !== null && "suggested_key" in def ? def.suggested_key : undefined;
  const chords: Record<string, unknown> =
    typeof suggested === "string"
      ? { default: suggested }
      : typeof suggested === "object" && suggested !== null
        ? Object.fromEntries(Object.entries(suggested))
        : {};
  const out: Array<[string, string, string]> = [];
  for (const platform of VALIDATED_SHORTCUT_PLATFORMS) {
    const chord = chords[platform];
    if (typeof chord !== "string") continue;
    const reason = shortcutError(chord);
    if (reason !== null) out.push([platform, chord, reason]);
  }
  return out;
}

function analyzeCommands(commands: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  for (const [name, def] of Object.entries(commands)) {
    for (const [platform, chord, reason] of invalidShortcuts(def)) {
      issues.push({
        severity: "warning",
        category: "ui",
        message: `commands.${name} shortcut "${chord}" (${platform}) isn't valid in Firefox: ${reason}. Firefox refuses a manifest with it, so the shortcut is removed.`,
        file: "manifest.json",
        fix: "Users can assign a shortcut in about:addons → Manage Extension Shortcuts.",
        autoFixed: true,
      });
    }
  }
  return issues;
}

// Chrome's CSP for manifest sandbox pages when the manifest sets none. Firefox
// applies script-src 'self' to them instead, so eval() and inline scripts fail.
const CHROME_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';";

// Sandbox pages with no sandbox CSP of their own: content_security_policy.sandbox in
// Manifest V3, sandbox.content_security_policy in V2. An MV3 string CSP is invalid
// in Chrome too and is left alone.
function lacksSandboxCsp(m: Manifest): boolean {
  if (strings(m.sandbox?.pages).length === 0) return false;
  const csp = m.content_security_policy;
  if ((m.manifest_version ?? 2) >= 3) return csp === undefined || (typeof csp === "object" && csp !== null && typeof csp.sandbox !== "string");
  const sandbox: unknown = m.sandbox;
  return typeof sandbox === "object" && sandbox !== null && typeof Reflect.get(sandbox, "content_security_policy") !== "string";
}

// Manifest keys Firefox added after its first Manifest V3 release, and what an older
// Firefox does when it meets them.
const KEY_GATES: Array<{ since: string; applies: (m: Manifest) => boolean; message: string; category: string }> = [
  {
    since: "112",
    applies: (m) => m.background?.type === "module",
    message: 'background.type: "module" needs Firefox 112; older releases don\'t load module background scripts.',
    category: "background",
  },
  {
    since: "127",
    applies: (m) => (m.manifest_version ?? 2) >= 3 && strings(m.host_permissions).length > 0,
    message: "host_permissions are granted at install only from Firefox 127; older releases leave them off until the user allows each site.",
    category: "permission",
  },
  {
    since: "128",
    applies: (m) => strings(m.optional_host_permissions).length > 0,
    message: "optional_host_permissions needs Firefox 128; older releases ignore the key, so permissions.request() for those sites fails.",
    category: "permission",
  },
  {
    since: "154",
    applies: (m) => strings(m.sandbox?.pages).length > 0,
    message: "sandbox pages need Firefox 154; older releases load them as ordinary extension pages, where eval() and inline scripts are blocked.",
    category: "manifest",
  },
];

export function analyzeManifest(m: Manifest, opts: { minFirefox: string }): ManifestAnalysis {
  const issues: Issue[] = [];
  const permissionsToRemove: string[] = [];
  const before = (version: string) => compareFirefoxVersions(opts.minFirefox, version) < 0;
  const mv = m.manifest_version ?? 2;
  const required = strings(m.permissions);
  const optional = strings(m.optional_permissions);
  // Port-wildcard patterns that become valid without the wildcard.
  const portWildcards = new Set<string>();
  const patternError = (pattern: string): string | null => {
    const fixed = withoutPortWildcard(pattern);
    const err = matchPatternError(fixed);
    if (err === null && fixed !== pattern) portWildcards.add(pattern);
    return err;
  };

  // Firefox validates content-script patterns strictly: one it can't parse makes it
  // refuse the whole manifest.
  const contentScripts = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  contentScripts.forEach((cs, i) => {
    if (typeof cs !== "object" || cs === null) return;
    const lists: Array<[string, unknown]> = [
      ["matches", cs.matches],
      ["exclude_matches", "exclude_matches" in cs ? cs.exclude_matches : undefined],
    ];
    for (const [key, list] of lists) {
      for (const pat of strings(list)) {
        const err = patternError(pat);
        if (err === null) {
          const port = portIssue(withoutPortWildcard(pat), `content_scripts[${i}].${key}`, "content_scripts");
          if (port) issues.push(port);
          continue;
        }
        issues.push({
          severity: "error",
          category: "content_scripts",
          message: `Invalid match pattern "${pat}" in content_scripts[${i}].${key}: ${err}. Firefox refuses to load a manifest with it.`,
          file: "manifest.json",
          fix: "Correct the pattern or remove it.",
        });
      }
    }
    if (cs.world === "MAIN" && before("128")) {
      issues.push({
        severity: "warning",
        category: "content_scripts",
        message: `content_scripts[${i}] uses world: "MAIN", which Firefox supports from 128; older releases run it in the isolated world, where it can't reach the page's own scripts.`,
        file: "manifest.json",
        fix: "Raise --min-firefox to 128 or later.",
      });
    }
  });

  // Firefox drops host patterns it can't parse with a warning; the transform removes
  // them so the manifest says what Firefox actually grants.
  for (const key of ["host_permissions", "optional_host_permissions"] as const) {
    for (const pat of strings(m[key])) {
      const err = patternError(pat);
      if (err === null) {
        const port = portIssue(withoutPortWildcard(pat), key, "permission");
        if (port) issues.push(port);
        continue;
      }
      issues.push({
        severity: "warning",
        category: "permission",
        message: `Invalid match pattern "${pat}" in ${key} will be removed: ${err}.`,
        file: "manifest.json",
        fix: "Firefox grants no access through this pattern; the remaining patterns still apply.",
        autoFixed: true,
      });
    }
  }

  for (const perm of new Set([...required, ...optional])) {
    if (perm === "<all_urls>" || perm.includes("://") || !Object.hasOwn(FIREFOX_PERMISSION_SUPPORT, perm)) continue;
    const since = FIREFOX_PERMISSION_SUPPORT[perm];
    if (since === null) {
      const shimmed = SHIMMED_PERMISSIONS.has(perm);
      issues.push({
        severity: shimmed ? "info" : "warning",
        category: "permission",
        message: shimmed
          ? `Permission "${perm}" is removed (Firefox doesn't know it), but the shim keeps the feature working.`
          : `Unsupported permission "${perm}" will be removed; Firefox doesn't have it.`,
        file: "manifest.json",
        fix: UNSUPPORTED_PERMISSIONS[perm],
        autoFixed: true,
        ...(shimmed ? { shimmed: true } : {}),
      });
      permissionsToRemove.push(perm);
    } else if (before(since)) {
      issues.push({
        severity: "warning",
        category: "permission",
        message: `Permission "${perm}" needs Firefox ${since}; older releases ignore it, so its API is missing there.`,
        file: "manifest.json",
        fix: `Raise --min-firefox to ${since}, or feature-detect the API.`,
      });
    }
  }

  for (const perm of optional) {
    if (!Object.hasOwn(INSTALL_TIME_PERMISSIONS, perm) || required.includes(perm)) continue;
    issues.push({
      severity: "warning",
      category: "permission",
      message: INSTALL_TIME_PERMISSIONS[perm]
        ? `Optional permission "${perm}" moves to permissions: Firefox ignores it in optional_permissions, so it asks for it at install instead.`
        : `Optional permission "${perm}" moves to permissions: Firefox grants it at install without a prompt and ignores it in optional_permissions.`,
      file: "manifest.json",
      fix: `permissions.request() for "${perm}" throws in Firefox; it is already granted, so check it with permissions.contains() first.`,
      autoFixed: true,
    });
  }
  for (const perm of required) {
    if (OPTIONAL_ONLY_PERMISSIONS[perm] !== true) continue;
    issues.push({
      severity: "warning",
      category: "permission",
      message: `Permission "${perm}" moves to optional_permissions: Firefox only grants it at runtime, so chrome.${perm} stays unavailable until the user allows it.`,
      file: "manifest.json",
      fix: `Call permissions.request({ permissions: ["${perm}"] }) on its own from a user action, or have users allow it in about:addons.`,
      autoFixed: true,
    });
  }

  // Host patterns among the API permissions. Firefox can't grant one it can't parse,
  // and Manifest V3 ignores host patterns in `permissions` (they belong in
  // host_permissions). Firefox does accept origins in optional_permissions.
  for (const key of ["permissions", "optional_permissions"] as const) {
    for (const perm of strings(m[key])) {
      if (perm !== "<all_urls>" && !perm.includes("://")) continue;
      const err = patternError(perm);
      if (err !== null) {
        const favicon = perm.startsWith("chrome://favicon");
        issues.push({
          severity: favicon ? "info" : "warning",
          category: "permission",
          message: `"${perm}" in ${key} isn't a pattern Firefox can grant (${err}); it will be removed.`,
          file: "manifest.json",
          fix: favicon ? "The shim serves chrome://favicon/ URLs itself." : "Firefox has no equivalent for this scheme.",
          autoFixed: true,
          ...(favicon ? { shimmed: true } : {}),
        });
      } else if (mv >= 3 && key === "permissions") {
        issues.push({
          severity: "warning",
          category: "permission",
          message: `"${perm}" is a host match pattern in "permissions"; under MV3 it is ignored and grants no host access.`,
          file: "manifest.json",
          fix: 'Move it into "host_permissions" (MV3 requires URL patterns there).',
        });
      } else {
        const port = portIssue(withoutPortWildcard(perm), key, "permission");
        if (port) issues.push(port);
      }
    }
  }
  for (const entry of Array.isArray(m.web_accessible_resources) ? m.web_accessible_resources : []) {
    if (typeof entry === "object" && entry !== null && "matches" in entry) for (const p of strings(entry.matches)) patternError(p);
  }
  if (portWildcards.size) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: `${[...portWildcards].join(", ")} use${portWildcards.size > 1 ? "" : "s"} a port wildcard, which Firefox doesn't have: it refuses a manifest whose content scripts use one and grants nothing through such a host permission. A Firefox pattern without a port matches every port, so the wildcard is dropped.`,
      file: "manifest.json",
      autoFixed: true,
    });
  }

  for (const gate of KEY_GATES) {
    if (!gate.applies(m) || !before(gate.since)) continue;
    issues.push({
      severity: "warning",
      category: gate.category,
      message: gate.message,
      file: "manifest.json",
      fix: `Raise --min-firefox to ${gate.since} or later.`,
    });
  }

  if (m.key) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "key (Chrome's packing key) means nothing to Firefox; removing it.",
      file: "manifest.json",
      fix: "The add-on's identity comes from browser_specific_settings.gecko.id.",
      autoFixed: true,
    });
  }
  if (m.update_url) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "update_url points at Chrome's update service; removing it.",
      file: "manifest.json",
      fix: "Firefox updates the add-on from AMO, or from browser_specific_settings.gecko.update_url when it is self-hosted.",
      autoFixed: true,
    });
  }
  if (m.minimum_chrome_version) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "minimum_chrome_version means nothing to Firefox; removing it (gecko.strict_min_version takes its place).",
      file: "manifest.json",
      autoFixed: true,
    });
  }

  const rawVersion = typeof m.version === "string" ? m.version.trim() : "";
  const version = toFirefoxVersion(rawVersion);
  if (!rawVersion) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: 'No version in the manifest; the add-on is packed as "0.0.0" unless --addon-version is given.',
      file: "manifest.json",
      fix: 'Add a numeric "version" (e.g. "1.0.0") to the manifest.',
      autoFixed: true,
    });
  } else if (version !== rawVersion) {
    issues.push({
      severity: /^[\d.]+$/.test(rawVersion) ? "info" : "warning",
      category: "manifest",
      message: `version "${rawVersion}" isn't a Firefox version (one to four integers of up to nine digits, no leading zeros); it is packed as "${version}".`,
      file: "manifest.json",
      fix: 'Use a numeric dotted version like "1.2.3", or pass --addon-version.',
      autoFixed: true,
    });
  }

  // Only extension_pages governs the extension's own pages; the sandbox policy relaxes
  // rules on purpose. A bare string is the MV2 form.
  const cspObj = m.content_security_policy;
  const csp = typeof cspObj === "string" ? cspObj : typeof cspObj?.extension_pages === "string" ? cspObj.extension_pages : "";
  const remoteSrc = new Set<string>();
  for (const dm of csp.matchAll(/(?:^|;)\s*script-src(?:-elem)?\s+([^;]+)/gi)) {
    for (const token of dm[1].trim().split(/\s+/)) {
      if (token === "*" || /^(https?:|\/\/|wss?:|\*:)/i.test(token) || /^(?:\*\.)?[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?$/i.test(token)) {
        remoteSrc.add(token);
      }
    }
  }
  if (remoteSrc.size > 0) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: `CSP script-src allows remote origin(s) (${[...remoteSrc].join(", ")}); Firefox refuses remote scripts in Manifest V3, and AMO's policies forbid loading remote code.`,
      file: "manifest.json",
      fix: "Bundle the script into the extension and load it locally.",
    });
  }

  if (lacksSandboxCsp(m)) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "sandbox pages without a sandbox CSP get script-src 'self' in Firefox, which blocks eval() and inline scripts there; Chrome's default sandbox CSP, which allows both, is written into the manifest.",
      file: "manifest.json",
      autoFixed: true,
    });
  }

  const bg = m.background;
  if (bg && typeof bg === "object" && typeof bg.service_worker === "string" && !Array.isArray(bg.scripts) && !bg.page) {
    issues.push({
      severity: "info",
      category: "background",
      message: `Firefox has no extension service workers; background.service_worker "${bg.service_worker}" runs as a background script (an event page) instead.`,
      file: "manifest.json",
      fix: "Event pages have a DOM and a window, so code that tests for a worker context may take a different branch.",
      autoFixed: true,
    });
  }

  if (m.side_panel !== undefined) {
    const sp = m.side_panel;
    const panel = typeof sp?.default_path === "string" ? sp.default_path : "";
    issues.push({
      severity: "info",
      category: "ui",
      message: m.sidebar_action
        ? "side_panel is removed; the manifest's own sidebar_action stays as Firefox's sidebar."
        : panel
          ? `side_panel becomes Firefox's sidebar (sidebar_action showing "${panel}"), which stays closed until the user opens it.`
          : "side_panel has no default_path, so no sidebar is declared; chrome.sidePanel.open() falls back to a popup window.",
      file: "manifest.json",
      fix: "Firefox opens the sidebar only from a user action, so sidePanel.open() outside one is refused.",
      autoFixed: true,
    });
  }

  if (m.incognito === "split") {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: 'incognito: "split" isn\'t supported in Firefox, which would fall back to "not_allowed"; the key is removed so the add-on also runs in private windows the user allows it in.',
      file: "manifest.json",
      fix: "Firefox shares one background between normal and private windows (spanning); keep private-window state apart in code if it matters.",
      autoFixed: true,
    });
  }

  const war: unknown[] = Array.isArray(m.web_accessible_resources) ? m.web_accessible_resources : [];
  const dynamic = war.filter((e): e is object => typeof e === "object" && e !== null && "use_dynamic_url" in e);
  if (dynamic.length) {
    const bare = dynamic.some((e) => !("matches" in e) && !("extension_ids" in e));
    issues.push({
      severity: "info",
      category: "resources",
      message:
        "web_accessible_resources use_dynamic_url is Chrome-only; it is removed, and the resources load from their regular moz-extension:// URL." +
        (bare ? " An entry left with neither matches nor extension_ids, which Firefox refuses the whole manifest over, goes with it; it opened its files to no web page." : ""),
      file: "manifest.json",
      fix: "Firefox already gives every install its own random moz-extension:// host.",
      autoFixed: true,
    });
  }

  const badMatches = [...new Set(invalidResourceMatches(m))];
  if (badMatches.length) {
    issues.push({
      severity: "info",
      category: "resources",
      message: `web_accessible_resources matches ${badMatches.join(", ")}, which Firefox refuses along with the whole manifest; the pattern is removed, and an entry left matching nothing goes with it.`,
      file: "manifest.json",
      fix: "The add-on's own pages load its files without being listed, and Firefox has no way to name another extension by its Chrome ID.",
      autoFixed: true,
    });
  }

  const badIds = [...new Set(invalidResourceExtensionIds(m))];
  if (badIds.length) {
    issues.push({
      severity: "info",
      category: "resources",
      message: `web_accessible_resources extension_ids lists ${badIds.join(", ")}, which Firefox refuses along with the whole manifest (it only takes add-on IDs and "*"); the IDs are removed, and an entry left matching nothing goes with it.`,
      file: "manifest.json",
      fix: "Those extensions have other IDs in Firefox; list their Firefox add-on IDs to share the files with them.",
      autoFixed: true,
    });
  }

  const favicon = remoteSearchFavicon(m);
  if (favicon !== null) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: `chrome_settings_overrides.search_provider.favicon_url is a web address (${favicon}); Firefox's Manifest V3 only takes a file in the add-on there and refuses the whole manifest otherwise, so it is removed.`,
      file: "manifest.json",
      fix: "Firefox shows the add-on's icon for the search engine instead.",
      autoFixed: true,
    });
  }

  for (const [key, url] of insecureSearchUrls(m)) {
    issues.push({
      severity: "error",
      category: "manifest",
      message: `chrome_settings_overrides.search_provider.${key} is ${url}; Firefox only takes https:// search engines (or a localhost address) and refuses to load a manifest with it.`,
      file: "manifest.json",
      fix: "Point it at the engine's https:// address.",
    });
  }

  if (typeof m.author === "object" && m.author !== null) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: 'author is an object ({"email": …}), which Chrome accepts and Firefox doesn\'t; it becomes the plain string Firefox expects.',
      file: "manifest.json",
      autoFixed: true,
    });
  }

  const ec = m.externally_connectable;
  if (strings(ec?.matches).length > 0) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "Firefox doesn't support externally_connectable, so the listed sites can't message the extension directly; the page bridge relays their runtime.sendMessage calls (a port from runtime.connect never connects).",
      file: "manifest.json",
      fix: "Re-test sign-in and site integrations; --no-oauth-bridge turns the bridge off.",
      shimmed: true,
    });
  }
  const ids = strings(ec?.ids).filter((id) => id !== "*");
  if (ids.length > 0) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: `externally_connectable.ids lists Chrome extension IDs (${ids.join(", ")}); those extensions have other IDs in Firefox, and any add-on may message this one.`,
      file: "manifest.json",
      fix: "Check senders against their Firefox add-on IDs instead.",
    });
  }

  if (required.includes("nativeMessaging") || optional.includes("nativeMessaging")) {
    issues.push({
      severity: "warning",
      category: "permission",
      message: "nativeMessaging needs the native app registered for Firefox: Firefox reads host manifests from its own locations, and they must list this add-on's ID in allowed_extensions instead of a chrome-extension:// origin.",
      file: "manifest.json",
      fix: `With --install or --native-hosts, ${NAME} registers this add-on with each native app it talks to whose Chrome host manifest is installed on this machine; other apps need a Firefox host manifest that names this add-on's ID.`,
    });
  }

  if (m.commands && typeof m.commands === "object") issues.push(...analyzeCommands(m.commands));

  const overrides = m.chrome_url_overrides;
  if (overrides && typeof overrides === "object") {
    for (const k of Object.keys(overrides)) {
      if (k === "newtab") continue;
      issues.push({
        severity: "warning",
        category: "ui",
        message: `chrome_url_overrides.${k} isn't supported in Firefox, which only lets add-ons replace the new tab page and refuses the whole manifest over any other override, so it is removed.`,
        file: "manifest.json",
        fix: "Open the page from the toolbar button or a menu instead.",
        autoFixed: true,
      });
    }
  }

  const icons = m.icons;
  if (!icons || typeof icons !== "object" || Object.keys(icons).length === 0) {
    issues.push({
      severity: "info",
      category: "ui",
      message: "No icons in the manifest; a placeholder icon set is generated.",
      file: "manifest.json",
      fix: "Replace it with real icons for production.",
      autoFixed: true,
    });
  }

  return { issues, permissionsToRemove };
}

/**
 * Collect every concrete file path the manifest references as a runtime asset
 * (scripts, pages, css, icons, web_accessible_resources, DNR rulesets, …),
 * normalized to forward-slash relative paths. Glob/wildcard resource entries
 * (containing '*') are skipped — only literal paths are returned. Used by the
 * stager so a declared resource is never dropped as "dev cruft" (e.g. a
 * web-accessible LICENSE.txt or a .map served to a page), which would 404 at
 * runtime.
 */
export function collectReferencedPaths(m: Manifest): Set<string> {
  const paths = new Set<string>();
  const add = (p: unknown) => {
    if (typeof p === "string" && p && !p.includes("*")) {
      // Drop any #fragment/?query (e.g. "devpanel.html#popup") so the concrete
      // file on disk is preserved during staging, not a phantom "…#popup" name.
      const filePart = p.split(/[#?]/)[0];
      if (filePart) paths.add(filePart.replace(/^\.?\//, "").replace(/\\/g, "/"));
    }
  };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  for (const cs of arr(m.content_scripts)) {
    if (typeof cs !== "object" || cs === null) continue;
    if ("js" in cs) for (const j of arr(cs.js)) add(j);
    if ("css" in cs) for (const c of arr(cs.css)) add(c);
  }
  for (const b of arr(m.background?.scripts)) add(b);
  add(m.background?.service_worker);
  add(m.background?.page);
  for (const a of [m.action, m.browser_action, m.page_action]) {
    add(a?.default_popup);
    const di = a?.default_icon;
    if (typeof di === "string") add(di);
    else if (di && typeof di === "object") for (const p of Object.values(di)) add(p);
  }
  for (const p of Object.values(m.icons ?? {})) add(p);
  add(m.options_page);
  add(m.options_ui?.page);
  add(m.devtools_page);
  for (const p of Object.values(m.chrome_url_overrides ?? {})) add(p);
  for (const p of arr(m.sandbox?.pages)) add(p);
  for (const r of arr(m.declarative_net_request?.rule_resources)) {
    if (typeof r === "object" && r !== null && "path" in r) add(r.path);
  }
  // side_panel.default_path becomes the Firefox sidebar page, so a miss here leaves an
  // empty sidebar.
  add(m.side_panel?.default_path);
  add(m.sidebar_action?.default_panel);
  const storage = m.storage;
  if (typeof storage === "object" && storage !== null && "managed_schema" in storage) add(storage.managed_schema);

  // web_accessible_resources: MV2 string[], MV3 [{resources: string[]}], or a bare
  // string (invalid, but hand-edited manifests produce it).
  if (typeof m.web_accessible_resources === "string") add(m.web_accessible_resources);
  for (const entry of arr(m.web_accessible_resources)) {
    if (typeof entry === "string") add(entry);
    else if (typeof entry === "object" && entry !== null && "resources" in entry) for (const r of arr(entry.resources)) add(r);
  }
  return paths;
}

export interface TransformOptions {
  /** browser_specific_settings.gecko.id. */
  addonId: string;
  /** browser_specific_settings.gecko.strict_min_version. */
  minFirefoxVersion: string;
  platforms: Platforms;
  /** Version written to the manifest, already in Firefox's format. */
  version: string;
  /** Values for gecko.data_collection_permissions.required; undefined leaves the key out. */
  dataCollection?: string[];
  /** Files put first in every content script that runs in the isolated world. */
  contentScriptPrepend?: string[];
  /** Query string added to the sidebar page made from side_panel. */
  sidebarPanelQuery?: string;
  /**
   * Page for a sidebar_action when the manifest declares no side_panel and the code
   * sets its panel through chrome.sidePanel.setOptions (see derivePanelPage).
   */
  sidebarPanel?: string;
  /** The shim emulates chrome.debugger: grant the APIs and site access it runs on. */
  debuggerEmulation?: boolean;
}

/** What the chrome.debugger emulation drives tabs with. */
export const DEBUGGER_EMULATION_PERMISSIONS = ["scripting", "tabs", "webNavigation", "webRequest"];

// Add `query` to a page path ahead of its fragment, after any query it already has.
function withQuery(path: string, query: string | undefined): string {
  const q = (query ?? "").replace(/^\?/, "");
  if (!q) return path;
  const hash = path.indexOf("#");
  const page = hash === -1 ? path : path.slice(0, hash);
  const fragment = hash === -1 ? "" : path.slice(hash);
  const sep = !page.includes("?") ? "?" : /[?&]$/.test(page) ? "" : "&";
  return page + sep + q + fragment;
}

/**
 * Produce the Firefox manifest. Pure: deep-clones its input and writes nothing.
 * `background` is left as it is; wireBackground rewrites it.
 */
export function transformManifest(m: Manifest, permissionsToRemove: string[], opts: TransformOptions): Manifest {
  const out: Manifest = JSON.parse(JSON.stringify(m));

  delete out.key;
  delete out.update_url;
  delete out.minimum_chrome_version;
  out.version = opts.version;

  // Drop what Firefox doesn't know, including patterns with schemes it can't grant,
  // then put each permission in the list Firefox reads it from.
  const removed = new Set(permissionsToRemove);
  const keep = (p: unknown): p is string =>
    typeof p === "string" && !removed.has(p) && (!p.includes("://") || matchPatternError(p) === null);
  const required = Array.isArray(out.permissions) ? out.permissions.map(withoutPortWildcard).filter(keep) : [];
  const optional = Array.isArray(out.optional_permissions) ? out.optional_permissions.map(withoutPortWildcard).filter(keep) : [];
  const permissions = [
    ...required.filter((p) => OPTIONAL_ONLY_PERMISSIONS[p] !== true),
    ...optional.filter((p) => Object.hasOwn(INSTALL_TIME_PERMISSIONS, p) && !required.includes(p)),
  ];
  const optionalPermissions = [
    ...optional.filter((p) => !Object.hasOwn(INSTALL_TIME_PERMISSIONS, p)),
    ...required.filter((p) => OPTIONAL_ONLY_PERMISSIONS[p] === true && !optional.includes(p)),
  ];
  // Chrome leaves blocking webRequest to policy-installed MV3 extensions, so store
  // manifests never declare webRequestBlocking. Code on a Firefox path (often keyed
  // on a moz-extension:// origin) still registers "blocking" listeners, which
  // Firefox refuses with an exception that stops the whole script. Firefox grants
  // it to MV3 add-ons along with webRequest, without a prompt.
  if ((out.manifest_version ?? 2) >= 3 && !permissions.includes("webRequestBlocking") && !optionalPermissions.includes("webRequestBlocking")) {
    if (permissions.includes("webRequest")) permissions.push("webRequestBlocking");
    else if (optionalPermissions.includes("webRequest")) optionalPermissions.push("webRequestBlocking");
  }
  // Chrome's debugger reaches every tab on its own permission. Its emulation runs
  // on these APIs, which need site access to every page as well.
  const allSites = opts.debuggerEmulation === true;
  if (allSites) {
    for (const p of DEBUGGER_EMULATION_PERMISSIONS) {
      if (!permissions.includes(p)) permissions.push(p);
      const i = optionalPermissions.indexOf(p);
      if (i >= 0) optionalPermissions.splice(i, 1);
    }
  }
  if (Array.isArray(out.permissions) || permissions.length) out.permissions = permissions;
  if (optionalPermissions.length) out.optional_permissions = optionalPermissions;
  else delete out.optional_permissions;

  for (const key of ["host_permissions", "optional_host_permissions"] as const) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    const kept = list.map(withoutPortWildcard).filter((p) => typeof p === "string" && matchPatternError(p) === null);
    if (kept.length) out[key] = kept;
    else delete out[key];
  }
  if (allSites) {
    // MV2 keeps host patterns among the permissions.
    const hostKey = (out.manifest_version ?? 2) >= 3 ? "host_permissions" : "permissions";
    const hosts = out[hostKey] ?? [];
    if (!hosts.includes("<all_urls>")) out[hostKey] = [...hosts, "<all_urls>"];
  }

  const bss = out.browser_specific_settings;
  const settings: NonNullable<Manifest["browser_specific_settings"]> =
    bss && typeof bss === "object" && !Array.isArray(bss) ? { ...bss } : {};
  const gecko: NonNullable<typeof settings.gecko> = {
    ...(settings.gecko && typeof settings.gecko === "object" ? settings.gecko : {}),
    id: opts.addonId,
  };
  // For Android alone, a desktop minimum would gate Firefox for Android as well.
  if (opts.platforms === "android") delete gecko.strict_min_version;
  else {
    gecko.strict_min_version = opts.minFirefoxVersion;
    // The author's cap below the minimum leaves no Firefox the add-on installs on.
    const max = gecko.strict_max_version;
    if (typeof max === "string" && compareFirefoxVersions(max, opts.minFirefoxVersion) < 0) delete gecko.strict_max_version;
  }
  if (opts.dataCollection) {
    const declared = typeof gecko.data_collection_permissions === "object" ? gecko.data_collection_permissions : {};
    gecko.data_collection_permissions = { ...declared, required: [...opts.dataCollection] };
  }
  settings.gecko = gecko;
  if (opts.platforms === "desktop") delete settings.gecko_android;
  else settings.gecko_android = {};
  out.browser_specific_settings = settings;

  // Firefox's sidebar takes the side panel's place: the manifest's side_panel, or
  // the page the code passes to chrome.sidePanel.setOptions when it declares
  // none. It opens on install unless told otherwise, which Chrome's side panel
  // never does.
  const sidePanelPath = typeof out.side_panel?.default_path === "string" ? out.side_panel.default_path : "";
  const panel = out.side_panel !== undefined ? sidePanelPath : (opts.sidebarPanel ?? "");
  if (!out.sidebar_action && panel) {
    const actionTitle = (out.action ?? out.browser_action ?? out.page_action)?.default_title;
    const title = typeof actionTitle === "string" && actionTitle ? actionTitle : out.name;
    const sidebar: NonNullable<Manifest["sidebar_action"]> = { default_panel: withQuery(panel, opts.sidebarPanelQuery) };
    if (title) sidebar.default_title = title;
    const icons = out.icons;
    if (icons && typeof icons === "object" && Object.keys(icons).length) sidebar.default_icon = { ...icons };
    sidebar.open_at_install = false;
    out.sidebar_action = sidebar;
  }
  delete out.side_panel;

  // Firefox would treat "split" as "not_allowed"; without the key the add-on spans
  // normal and private windows.
  if (out.incognito === "split") delete out.incognito;

  if (lacksSandboxCsp(out)) {
    if ((out.manifest_version ?? 2) >= 3) {
      const csp = out.content_security_policy;
      out.content_security_policy = { ...(typeof csp === "object" && csp !== null ? csp : {}), sandbox: CHROME_SANDBOX_CSP };
    } else {
      out.sandbox = Object.assign({}, out.sandbox, { content_security_policy: CHROME_SANDBOX_CSP });
    }
  }

  // An extension that only adds rules at runtime may declare rule_resources: [],
  // which Chrome accepts. Firefox wants at least one ruleset there and refuses the
  // whole manifest otherwise; the permission alone gives the API.
  const rules = out.declarative_net_request?.rule_resources;
  if (Array.isArray(rules) && rules.length === 0) delete out.declarative_net_request;

  if (Array.isArray(out.web_accessible_resources)) {
    out.web_accessible_resources = out.web_accessible_resources.filter((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return true;
      Reflect.deleteProperty(entry, "use_dynamic_url");
      if ("extension_ids" in entry && Array.isArray(entry.extension_ids)) {
        const ids = entry.extension_ids.filter(resourceExtensionIdOk);
        if (ids.length) entry.extension_ids = ids;
        else Reflect.deleteProperty(entry, "extension_ids");
      }
      // Chrome takes use_dynamic_url as an entry's only key besides resources, and
      // such an entry opens its files to no web page. Firefox refuses the whole
      // manifest over an entry with neither matches nor extension_ids.
      if (!("matches" in entry)) return "extension_ids" in entry;
      if (!Array.isArray(entry.matches)) return true;
      const kept = entry.matches.map(withoutPortWildcard).filter((p: unknown) => typeof p === "string" && matchPatternError(p) === null);
      if (kept.length || entry.matches.length === 0) {
        entry.matches = kept;
        return true;
      }
      Reflect.deleteProperty(entry, "matches");
      return "extension_ids" in entry;
    });
  }

  const overrides = out.chrome_settings_overrides;
  if (remoteSearchFavicon(out) !== null && typeof overrides === "object" && overrides !== null && "search_provider" in overrides) {
    const provider = overrides.search_provider;
    if (typeof provider === "object" && provider !== null) Reflect.deleteProperty(provider, "favicon_url");
  }

  if (typeof out.author === "object" && out.author !== null) {
    const email = "email" in out.author ? out.author.email : undefined;
    if (typeof email === "string" && email) out.author = email;
    else delete out.author;
  }

  // Firefox's schema marks every override but newtab unsupported, which makes it
  // refuse the whole manifest.
  const urlOverrides = out.chrome_url_overrides;
  if (urlOverrides && typeof urlOverrides === "object") {
    for (const k of Object.keys(urlOverrides)) if (k !== "newtab") Reflect.deleteProperty(urlOverrides, k);
    if (Object.keys(urlOverrides).length === 0) delete out.chrome_url_overrides;
  }

  // A shortcut Firefox can't parse makes it refuse the manifest. Drop just that chord;
  // the command stays, and users can bind it in about:addons.
  if (out.commands && typeof out.commands === "object") {
    for (const def of Object.values(out.commands)) {
      if (typeof def !== "object" || def === null || !("suggested_key" in def)) continue;
      if (typeof def.suggested_key === "string") def.suggested_key = { default: def.suggested_key };
      const suggested = def.suggested_key;
      if (typeof suggested !== "object" || suggested === null) continue;
      for (const [platform] of invalidShortcuts(def)) Reflect.deleteProperty(suggested, platform);
      if (Object.keys(suggested).length === 0) delete def.suggested_key;
    }
  }

  // Content-script patterns lose a port wildcard. Chrome accepts an empty
  // exclude_matches; Firefox wants at least one pattern and refuses the whole
  // manifest otherwise. An empty list excludes nothing either way.
  if (Array.isArray(out.content_scripts)) {
    for (const cs of out.content_scripts) {
      if (!cs || typeof cs !== "object") continue;
      if (Array.isArray(cs.matches)) cs.matches = cs.matches.map(withoutPortWildcard);
      if (!("exclude_matches" in cs) || !Array.isArray(cs.exclude_matches)) continue;
      if (cs.exclude_matches.length === 0) Reflect.deleteProperty(cs, "exclude_matches");
      else cs.exclude_matches = cs.exclude_matches.map(withoutPortWildcard);
    }
  }

  const prepend = opts.contentScriptPrepend ?? [];
  if (prepend.length && Array.isArray(out.content_scripts)) {
    for (const cs of out.content_scripts) {
      // MAIN-world scripts run in the page, where extension APIs don't exist.
      if (!cs || !Array.isArray(cs.js) || cs.js.length === 0 || cs.world === "MAIN") continue;
      const js = cs.js;
      cs.js = [...prepend.filter((f) => !js.includes(f)), ...js];
    }
  }

  return out;
}

export function writeManifest(targetDir: string, manifest: Manifest): void {
  writeFileSync(join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}
