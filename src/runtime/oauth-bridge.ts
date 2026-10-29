import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import type { Manifest } from "../types.js";
import { TEMPLATE_DIR } from "../paths.js";
import { NAME } from "../name.js";
import { walkScripts } from "../input/stage.js";
import { SHIM_FILENAME, insertAtHeadStart } from "./shim.js";

/** Page-world script on the externally_connectable pages: provides chrome.runtime.sendMessage. */
export const BRIDGE_PAGE = `${NAME}-page-bridge.js`;
/** Content-script relay on the same pages, carrying page messages to the background. */
export const BRIDGE_PAGE_CS = `${NAME}-page-bridge-cs.js`;
/** Background receiver that hands page messages to the extension's onMessageExternal listeners. */
export const BRIDGE_BACKGROUND = `${NAME}-page-bridge-bg.js`;

/** Staged file name → bundled template. */
const TEMPLATES: Record<string, string> = {
  [BRIDGE_PAGE]: "page-bridge.js",
  [BRIDGE_PAGE_CS]: "page-bridge-cs.js",
  [BRIDGE_BACKGROUND]: "page-bridge-bg.js",
};
/** Placeholder for the extension's Chrome ID; left alone when the ID isn't known. */
const EXT_ID_PLACEHOLDER = "__EXTENSION_ID__";
/** Placeholder for the channel that keeps this add-on's bridge apart from others on the same page. */
const CHANNEL_PLACEHOLDER = "__BRIDGE_CHANNEL__";

/**
 * What the bridge gains for the sites the add-on frames in its own pages (see
 * framedSites): spliced in at the marker, which is dropped otherwise, so a
 * bridge without them never ships their code.
 */
const FRAME_SPLICES: Record<string, { marker: string; template: string }> = {
  [BRIDGE_PAGE]: { marker: "  // __FRAME_VIEW__\n", template: "frame-view-page.js" },
  [BRIDGE_PAGE_CS]: { marker: "  // __FRAME_VIEW__\n", template: "frame-view-cs.js" },
  [BRIDGE_BACKGROUND]: { marker: "  // __FRAME_GRANTS__\n", template: "frame-grants-bg.js" },
};
/** Placeholder for the framed sites' match patterns, as a JSON array. */
const FRAME_SITES_PLACEHOLDER = "__FRAME_SITES__";

/** A frame-making page or script: <iframe> markup, or createElement("iframe") and the like. */
const MAKES_FRAMES_RE = /<iframe\b|["'`]iframe["'`]/i;
const URL_LITERAL_RE = /["'`](https?:\/\/[^"'`\s<>\\]+)/g;

/** Whether a match pattern (Chrome's syntax) matches a URL. */
function patternMatches(pattern: string, url: URL): boolean {
  const web = url.protocol === "http:" || url.protocol === "https:";
  if (pattern === "<all_urls>") return web;
  const m = /^(\*|https?|wss?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, rawHost, path] = m;
  if (scheme === "*" ? !web : url.protocol !== `${scheme}:`) return false;
  const host = rawHost.toLowerCase();
  if (host !== "*") {
    const base = host.startsWith("*.") ? host.slice(2) : host;
    if (url.hostname !== base && !(host.startsWith("*.") && url.hostname.endsWith(`.${base}`))) return false;
  }
  const pathRe = path
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pathRe}$`).test(url.pathname + url.search);
}

function bridgedMatches(manifest: Manifest): string[] {
  const raw = manifest.externally_connectable?.matches;
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string" && m.length > 0) : [];
}

/**
 * The externally_connectable sites the add-on frames in its own pages, as
 * match patterns: http(s) URLs on a site externally_connectable.matches lists,
 * written in a page or script of the add-on (not a content script) that makes
 * frames. A site that grants such an extension its Chrome origin in
 * frame-ancestors expects to be framed there; the bridge keeps that working
 * (see frame-grants-bg.js and frame-view-page.js). A URL built at runtime
 * isn't seen.
 */
export function framedSites(stageDir: string, manifest: Manifest): string[] {
  const matches = bridgedMatches(manifest);
  if (matches.length === 0) return [];
  const contentScripts = new Set(
    (Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [])
      .flatMap((cs) => (Array.isArray(cs.js) ? cs.js : []))
      .map((f) => f.replace(/^(?:\.?\/)+/, "")),
  );
  const sites = new Set<string>();
  for (const file of walkScripts(stageDir, [], [".js", ".mjs", ".html", ".htm"])) {
    const rel = relative(stageDir, file).split("\\").join("/");
    // The shim and the bridge are the converter's, not the add-on's pages.
    if (contentScripts.has(rel) || rel.startsWith(`${NAME}-`)) continue;
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!MAKES_FRAMES_RE.test(src)) continue;
    for (const m of src.matchAll(URL_LITERAL_RE)) {
      let url: URL;
      try {
        url = new URL(m[1]);
      } catch {
        continue;
      }
      if (matches.some((p) => patternMatches(p, url))) sites.add(`${url.protocol}//${url.hostname}/*`);
    }
  }
  return [...sites].sort();
}

function frameSplice(template: string, sites: string[]): string {
  const json = JSON.stringify(sites).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
  return readFileSync(join(TEMPLATE_DIR, template), "utf-8").split(FRAME_SITES_PLACEHOLDER).join(json);
}

/**
 * Permissions the frame grants run on: blocking webRequest to see the site's
 * policy and load the frame again, a session rule to set the frame's policy,
 * and access to the sites themselves.
 */
function grantFramePermissions(manifest: Manifest, sites: string[]): void {
  const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const add = (p: string) => {
    if (!perms.includes(p)) perms.push(p);
  };
  add("webRequest");
  add("webRequestBlocking");
  if (!perms.includes("declarativeNetRequest")) add("declarativeNetRequestWithHostAccess");
  manifest.permissions = perms;
  const hostKey = (manifest.manifest_version ?? 3) >= 3 ? "host_permissions" : "permissions";
  const hosts = Array.isArray(manifest[hostKey]) ? (manifest[hostKey] as string[]) : [];
  for (const site of sites) {
    const url = new URL(site.slice(0, -1));
    if (!hosts.some((p) => typeof p === "string" && patternMatches(p, url))) hosts.push(site);
  }
  manifest[hostKey] = hosts;
}

/**
 * Derive an extension's Chrome id from its manifest `key` (base64 DER public key).
 * Chrome's rule: SHA-256 the decoded key, take the first 16 bytes, and map each
 * nibble 0–15 to a–p. Returns undefined for an unpacked extension (no key) or a
 * malformed key.
 */
export function deriveChromeId(manifest: Manifest): string | undefined {
  const key = manifest.key;
  if (typeof key !== "string" || key.length === 0) return undefined;
  // Buffer.from(str, "base64") never throws — it decodes what it can and ignores
  // invalid chars — so a length check (not a try/catch) is the real malformed-key
  // guard. An empty decode means the key had no valid base64 at all.
  const der = Buffer.from(key, "base64");
  if (der.length === 0) return undefined;
  const digest = createHash("sha256").update(der).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

/**
 * Let the pages listed in `externally_connectable.matches` keep messaging the
 * extension. Chrome gives those pages, in any frame, `chrome.runtime.sendMessage(<id>, …)`
 * and delivers to the extension's `runtime.onMessageExternal` listeners; Firefox
 * ignores the key and gives web pages no `chrome.runtime` at all. This stages
 * three scripts and wires them in:
 *   - an isolated-world relay that carries each message to the background;
 *   - a page-world content script that provides `chrome.runtime.sendMessage`;
 *   - a background receiver, loaded ahead of the extension's own background code,
 *     that hands the message to the captured onMessageExternal listeners with the
 *     page as the sender.
 * The `externally_connectable` key is removed once the bridge replaces it.
 *
 * When the Chrome ID is known and the add-on's own pages frame one of those
 * sites (framedSites), the bridge also keeps such frames working: the site's
 * frame-ancestors grant to the Chrome origin is extended to this add-on's
 * origin, and the framed page sees its parent as the Chrome origin.
 *
 * Works whether the background is still a service worker (the receiver is
 * imported by it, so wireBackground puts it ahead of the worker) or has already
 * been wired as `background.scripts` or a `page`. Mutates `manifest`; returns
 * notes for the report.
 */
export function applyOAuthBridge(stageDir: string, manifest: Manifest, chromeId?: string): string[] {
  const matches = bridgedMatches(manifest);
  if (matches.length === 0) return [];
  const bg = manifest.background;
  if (!bg || (typeof bg.service_worker !== "string" && !Array.isArray(bg.scripts) && typeof bg.page !== "string")) {
    return ["Page bridge skipped: the extension has no background to receive messages from externally_connectable pages."];
  }
  const sites = chromeId ? framedSites(stageDir, manifest) : [];

  // Derived rather than random so the packed add-on is identical between runs.
  const channel = createHash("sha256")
    .update(JSON.stringify([chromeId ?? "", manifest.name ?? "", matches]))
    .digest("hex")
    .slice(0, 16);
  for (const [staged, template] of Object.entries(TEMPLATES)) {
    const { marker, template: splice } = FRAME_SPLICES[staged];
    let src = readFileSync(join(TEMPLATE_DIR, template), "utf-8")
      .split(marker)
      .join(sites.length > 0 ? frameSplice(splice, sites) : "")
      .split(CHANNEL_PLACEHOLDER)
      .join(channel);
    if (chromeId) src = src.split(EXT_ID_PLACEHOLDER).join(chromeId);
    writeFileSync(join(stageDir, staged), src, "utf-8");
  }

  wireReceiver(stageDir, manifest);

  // The relay goes first: in a frame of the add-on's own page it hands the
  // page-world script the add-on's origin before any of the page's scripts run.
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  if (!scripts.some((cs) => Array.isArray(cs.js) && cs.js.includes(BRIDGE_PAGE))) {
    scripts.unshift(
      { js: [BRIDGE_PAGE_CS], matches, run_at: "document_start", all_frames: true },
      { js: [BRIDGE_PAGE], matches, run_at: "document_start", all_frames: true, world: "MAIN" },
    );
  }
  manifest.content_scripts = scripts;
  delete manifest.externally_connectable;
  const notes = [`Page bridge wired for externally_connectable pages: ${matches.join(", ")}`];
  if (sites.length > 0) {
    grantFramePermissions(manifest, sites);
    const hosts = sites.map((s) => new URL(s.slice(0, -1)).host).join(", ");
    const why = (manifest.manifest_version ?? 3) >= 3 ? " (an MV3 add-on can replace a page's CSP, not edit it)" : "";
    notes.push(
      `Frames of ${hosts} in the add-on's own pages: where the site's frame-ancestors lists chrome-extension://${chromeId}, ` +
        `this add-on's origin is let in too, and that frame keeps only the site's frame-ancestors, object-src and base-uri${why}; ` +
        "the framed page sees its parent as the Chrome origin",
    );
  }
  return notes;
}

/** Load the receiver before the extension's own background code. */
function wireReceiver(stageDir: string, manifest: Manifest): void {
  const bg = manifest.background;
  if (!bg) return;
  if (Array.isArray(bg.scripts)) {
    if (!bg.scripts.includes(BRIDGE_BACKGROUND)) bg.scripts.splice(bg.scripts[0] === SHIM_FILENAME ? 1 : 0, 0, BRIDGE_BACKGROUND);
    return;
  }
  if (typeof bg.service_worker === "string") {
    const sw = bg.service_worker.replace(/^(?:\.?\/)+/, "");
    const swPath = join(stageDir, sw);
    if (!existsSync(swPath)) return;
    const src = readFileSync(swPath, "utf-8");
    if (bg.type === "module") {
      // A module's imports run before its body.
      let rel = relative(dirname(sw), BRIDGE_BACKGROUND).split("\\").join("/");
      if (!rel.startsWith(".")) rel = "./" + rel;
      const line = `import "${rel}";\n`;
      if (!src.startsWith(line)) writeFileSync(swPath, line + src, "utf-8");
    } else {
      // wireBackground hoists this like any other importScripts target.
      const call = `importScripts("/${BRIDGE_BACKGROUND}");\n`;
      if (src.includes(call)) return;
      const at = directivePrologueEnd(src);
      writeFileSync(swPath, at > 0 ? src.slice(0, at) + "\n" + call + src.slice(at) : call + src, "utf-8");
    }
    return;
  }
  if (typeof bg.page === "string") {
    const pagePath = join(stageDir, bg.page.replace(/^\/+/, ""));
    if (!existsSync(pagePath)) return;
    const tag = `<script src="/${BRIDGE_BACKGROUND}"></script>`;
    const html = readFileSync(pagePath, "utf-8");
    if (!html.includes(tag)) writeFileSync(pagePath, insertAtHeadStart(html, tag), "utf-8");
  }
}

const TRIVIA_RE = /(?:\uFEFF|\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
const DIRECTIVE_RE = /(["'])(?:(?!\1)[^\\\r\n]|\\.)*\1[ \t]*(;)?(?=[ \t]*(?:\r?\n|$)|(?<=;))/y;

/**
 * End of a script's directive prologue ("use strict"; and friends), so code can be
 * inserted after it: anything placed ahead of "use strict" turns the directive into
 * a plain expression and the script silently loses strict mode. Returns 0 when the
 * script has no prologue.
 */
function directivePrologueEnd(src: string): number {
  let at = 0;
  let end = 0;
  for (;;) {
    TRIVIA_RE.lastIndex = at;
    TRIVIA_RE.exec(src);
    at = TRIVIA_RE.lastIndex;
    DIRECTIVE_RE.lastIndex = at;
    const m = DIRECTIVE_RE.exec(src);
    if (!m) return end;
    if (!m[2]) {
      // Without a semicolon the string only ends the statement if the next line
      // can't continue the expression.
      const next = /\S/.exec(src.slice(DIRECTIVE_RE.lastIndex));
      if (next && /[.([`+\-*/%,?=<>&|]/.test(next[0])) return end;
    }
    at = DIRECTIVE_RE.lastIndex;
    end = at;
  }
}
