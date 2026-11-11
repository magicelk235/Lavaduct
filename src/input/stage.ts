import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, lstatSync, statSync, realpathSync, copyFileSync } from "node:fs";
import { join, dirname, resolve, relative, sep, posix } from "node:path";
import type { Manifest } from "../types.js";
import { parseJsonc } from "../manifest/manifest.js";

/** Names/globs excluded from the clean staged extension. */
const EXCLUDE_EXACT = new Set([
  ".DS_Store",
  "__MACOSX",
  ".git",
  ".gitignore",
  ".github",
  ".svn",
  "node_modules",
  "_metadata", // Chrome Web Store signing metadata
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "tsconfig.json",
  // Credentials and editor settings a source folder holds; never runtime files.
  ".npmrc",
  ".vscode",
  ".idea",
  // A Recommended add-on's AMO badge; addons-linter refuses the name anywhere.
  "mozilla-recommendation.json",
]);
// Excluded at the package root only: a signed .xpi's signature, which covers the
// files and add-on ID the conversion changes.
const SIGNATURE_DIR = "META-INF";

const EXCLUDE_SUFFIX = [".map", ".ts", ".tsx", ".md", ".log", ".pem"];
// Doc/config files: bare name or name + extension only (e.g. "LICENSE",
// "LICENSE.txt"), never a prefix match — that would drop legit runtime files
// like "LICENSE_KEY.js" or "READMExporter.js".
// Only doc-typed variants (or the bare name). A runtime file that merely shares
// the name — changelog.html, license.js, Changelog.json — must ship, or it 404s
// at runtime (only manifest-referenced paths are otherwise protected).
const EXCLUDE_DOC_RE = /^(README|CHANGELOG|LICENSE)(\.(txt|md|markdown|rst|adoc))?$/i;
// Tool dotfiles, and .env files with their secrets (.env, .env.local, …).
const EXCLUDE_DOTFILE = [".eslint", ".prettier"];
const ENV_FILE_RE = /^\.env(\..+)?$/;

function shouldExclude(name: string): boolean {
  if (EXCLUDE_EXACT.has(name)) return true;
  if (EXCLUDE_SUFFIX.some((s) => name.endsWith(s))) return true;
  if (EXCLUDE_DOC_RE.test(name)) return true;
  if (EXCLUDE_DOTFILE.some((p) => name.startsWith(p))) return true;
  if (ENV_FILE_RE.test(name)) return true;
  return false;
}

/**
 * Copy the extension into stageDir, dropping dev cruft and store metadata.
 * The manifest + shim are written separately by the caller afterward.
 * stageDir is recreated fresh each run.
 *
 * `keep` is a set of manifest-relative paths (forward-slash) that the manifest
 * declares as runtime assets; these are copied even if their name matches an
 * exclusion rule — otherwise a web-accessible LICENSE.txt or a .map served to a
 * page would be dropped and 404 at runtime.
 *
 * Returns the manifest-referenced asset paths that could NOT be staged (a kept
 * symlink whose target escaped the tree, vanished, or failed to copy). The caller
 * warns on these — otherwise they 404 in Firefox with no build-time signal.
 */
export function stageExtension(sourceDir: string, stageDir: string, keep: Set<string> = new Set()): string[] {
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const root = resolve(sourceDir);
  // Realpath'd root for the kept-symlink containment check below. resolve() doesn't
  // collapse symlinked ancestors, but realpathSync(srcLink) does — so on macOS where
  // scratch dirs live under /tmp (a symlink to /private/tmp), an in-tree target would
  // realpath to /private/... and fail `startsWith(root)`, silently dropping the asset.
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch { /* source missing → cpSync errors anyway */ }
  // Copy from the real path: when the source folder itself is a symlink (a dist/
  // link, bazel-bin), cpSync would try to recreate that link at stageDir instead of
  // copying the tree, and fail with EEXIST on the stageDir just made.
  cpSync(realRoot, stageDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(realRoot, resolve(src)).split(sep).join("/");
      if (rel === "") return true; // the stage root itself
      // Never copy symlinks into the package. cpSync reproduces them verbatim, so a
      // link in the source (evil.txt -> /etc/hosts) would ship a dangling/absolute
      // link that leaks the build host's layout and 404s at runtime. Drop them.
      // lstat can throw on a broken/racing entry; an unguarded throw here escapes the
      // filter and aborts the whole copy with an opaque ENOENT — exclude on error.
      let st;
      try { st = lstatSync(src); } catch { return false; }
      if (st.isSymbolicLink()) return false;
      // A manifest-referenced path is always kept, even under an excluded ancestor.
      if (keep.has(rel)) return true;
      // Excluded if its own name OR any ancestor segment is excluded — this stops a
      // file like _metadata/junk.js (parent excluded) from riding in just because
      // its own basename is clean.
      const segments = rel.split("/");
      if (segments.some(shouldExclude) || segments[0] === SIGNATURE_DIR) {
        // Still allow an excluded directory to be entered when a kept path lives
        // inside it; cpSync won't recurse otherwise and the kept child is lost.
        const asDir = rel + "/";
        for (const k of keep) if (k.startsWith(asDir)) return true;
        return false;
      }
      return true;
    },
  });

  // The filter above drops ALL symlinks (verbatim-copied links 404 at runtime and
  // leak the build host's layout). But a manifest-referenced asset that happens to
  // be a symlink in the source (common with pnpm/monorepo asset linking) is a real
  // runtime dependency — dropping it 404s the page that needs it. For kept paths
  // only, dereference the link and copy the actual target file (staying inside the
  // source tree) so the bytes ship without the dangling-link hazard.
  const dropped: string[] = [];
  for (const rel of keep) {
    const srcLink = join(root, rel);
    let lst;
    try { lst = lstatSync(srcLink); } catch { continue; }
    // Skip only when it's a plain file cpSync already staged. A non-link that never
    // got staged means an ancestor directory was a symlink (dropped by the filter),
    // so fall through and dereference it via realpathSync below.
    if (!lst.isSymbolicLink() && existsSync(join(stageDir, rel))) continue;
    if (!copyInTreeFile(root, realRoot, rel, stageDir)) dropped.push(rel);
  }

  stageLoadedAssets(root, realRoot, stageDir);
  return dropped;
}

/**
 * Copy root/rel to stageDir/rel, dereferencing a symlink only when its target is a
 * regular file inside the source tree (compared against the realpath'd root so a
 * symlinked ancestor like /tmp→/private/tmp doesn't make an in-tree target look
 * external). False when nothing was copied.
 */
function copyInTreeFile(root: string, realRoot: string, rel: string, stageDir: string): boolean {
  let target;
  try {
    target = realpathSync(join(root, rel));
    if (target !== realRoot && !target.startsWith(realRoot + sep)) return false;
    if (!statSync(target).isFile()) return false;
  } catch { return false; }
  const dest = join(stageDir, rel);
  try { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(target, dest); }
  catch { return false; }
  return true;
}

// The exclusion rules judge files by name, and the manifest only names its entry
// points, so a file an extension page or script loads by path can be dropped as
// cruft: `<script src="node_modules/jquery/dist/jquery.min.js">` in a popup,
// `importScripts("node_modules/…")` in a worker, a stylesheet's `url()` into an
// excluded folder, an about page linking LICENSE.txt. Chrome serves every file in
// the package, so each of these 404s only after conversion. Follow the references
// the staged pages, stylesheets and scripts make and bring back any file they name
// that staging left out. Only actual loads are followed (attribute values, url()
// and @import, importScripts, relative import specifiers, getURL and Worker
// arguments), so a word like "LICENSE" in a comment rescues nothing, and a
// sourceMappingURL comment is not a load: dropped .map files stay dropped.
const PAGE_EXTS = [".html", ".htm", ".xhtml"];
const STYLE_EXTS = [".css"];
const SCRIPT_EXTS = [".js", ".mjs"];
const HTML_REF_RE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/gi;
const CSS_REF_RE = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const SCRIPT_CALL_RE = /\b(?:importScripts|getURL|Worker)\s*\(([^)]*)\)/g;
const SCRIPT_IMPORT_RE = /(?:\bimport\s*\(?|\bfrom)\s*(?:"(\.{0,2}\/[^"\n]*)"|'(\.{0,2}\/[^'\n]*)')/g;
const STRING_LITERAL_RE = /"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`/g;

function referencesIn(rel: string, text: string): string[] {
  const lower = rel.toLowerCase();
  const refs: string[] = [];
  const collect = (re: RegExp) => {
    for (const m of text.matchAll(re)) {
      const v = m.slice(1).find((g) => g !== undefined);
      if (v) refs.push(v);
    }
  };
  if (PAGE_EXTS.some((e) => lower.endsWith(e))) {
    collect(HTML_REF_RE);
    collect(CSS_REF_RE); // inline <style> and style="" attributes
  } else if (STYLE_EXTS.some((e) => lower.endsWith(e))) {
    collect(CSS_REF_RE);
  } else {
    for (const m of text.matchAll(SCRIPT_CALL_RE)) {
      for (const s of m[1].matchAll(STRING_LITERAL_RE)) {
        const v = s.slice(1).find((g) => g !== undefined);
        if (v) refs.push(v);
      }
    }
    collect(SCRIPT_IMPORT_RE);
  }
  return refs;
}

/**
 * Package-relative paths a reference from `fromRel` may point at. Root-absolute
 * references resolve against the package root. A relative one resolves against
 * the referencing file, and also against the root, because a script's relative
 * fetches and getURL calls resolve against its page or the package root, not the
 * script. Out-of-package and remote references give nothing.
 */
function candidatePaths(fromRel: string, ref: string): string[] {
  let path = ref.trim().split(/[?#]/)[0];
  if (!path || path.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(path)) return [];
  try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
  const out = new Set<string>();
  const add = (p: string) => {
    const n = posix.normalize(p);
    if (n && n !== "." && n !== ".." && !n.startsWith("../") && !posix.isAbsolute(n)) out.add(n);
  };
  if (path.startsWith("/")) add(path.slice(1));
  else {
    add(posix.join(posix.dirname(fromRel), path));
    add(path);
  }
  return [...out];
}

function stageLoadedAssets(root: string, realRoot: string, stageDir: string): void {
  const isText = (rel: string) => {
    const lower = rel.toLowerCase();
    return [...PAGE_EXTS, ...STYLE_EXTS, ...SCRIPT_EXTS].some((e) => lower.endsWith(e));
  };
  const queue: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.isFile() && isText(r)) queue.push(r);
    }
  };
  walk(stageDir, "");
  while (queue.length > 0) {
    const rel = queue.pop() as string;
    let text: string;
    try { text = readFileSync(join(stageDir, rel), "utf-8"); } catch { continue; }
    for (const ref of referencesIn(rel, text)) {
      for (const cand of candidatePaths(rel, ref)) {
        if (existsSync(join(stageDir, cand))) continue;
        // A rescued page or script can load further files itself.
        if (copyInTreeFile(root, realRoot, cand, stageDir) && isText(cand)) queue.push(cand);
      }
    }
  }
}

/**
 * Whether Firefox's JSON reader (Extension.sys.mjs readJSON) takes `text`: it cuts
 * `//` comments outside strings, throws on any other `/`, then calls JSON.parse.
 */
function firefoxReadsJson(text: string): boolean {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i;
      do {
        end = text.indexOf('"', end + 1);
        if (end === -1) return false;
        let backslashes = 0;
        for (let k = end - 1; text[k] === "\\"; k--) backslashes++;
        if (backslashes % 2 === 0) break;
      } while (true);
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === "/") {
      if (text[i + 1] !== "/") return false;
      const nl = text.indexOf("\n", i + 2);
      i = (nl === -1 ? text.length : nl) - 1;
    } else out += c;
  }
  try {
    JSON.parse(out);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove each _locales subfolder without a messages.json Chrome can read, except
 * the default locale's (the analyzer reports that one). Chrome ignores a folder
 * whose name isn't one of its locales and refuses an extension whose locale
 * folder lacks a readable catalog, so a working Chrome extension can only carry
 * such a folder as junk Chrome skips (`_locales/xx/`, an empty folder). Firefox
 * reads every subfolder and refuses the whole add-on over one it can't load.
 * Returns the removed folders.
 */
export function removeUnreadableLocales(stageDir: string, defaultLocale: string | undefined): string[] {
  const localesDir = join(stageDir, "_locales");
  let locales;
  try {
    locales = readdirSync(localesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const locale of locales) {
    if (!locale.isDirectory() || locale.name === defaultLocale) continue;
    try {
      parseJsonc(readFileSync(join(localesDir, locale.name, "messages.json"), "utf-8"));
    } catch {
      rmSync(join(localesDir, locale.name), { recursive: true, force: true });
      removed.push(`_locales/${locale.name}`);
    }
  }
  return removed;
}

/**
 * Rewrite as plain JSON each _locales/<locale>/messages.json that Chrome reads and
 * Firefox doesn't. Chrome's reader also takes block comments, line breaks inside
 * strings and \x escapes; Firefox's only cuts // comments, and it refuses the whole
 * add-on when any locale's catalog fails to parse. A catalog Firefox reads is left
 * byte for byte, and one Chrome can't read either is left for the analyzer to
 * report. Returns the rewritten paths.
 */
export function normalizeLocaleCatalogs(stageDir: string): string[] {
  const localesDir = join(stageDir, "_locales");
  let locales;
  try {
    locales = readdirSync(localesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rewritten: string[] = [];
  for (const locale of locales) {
    if (!locale.isDirectory()) continue;
    const file = join(localesDir, locale.name, "messages.json");
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (firefoxReadsJson(text)) continue;
    let messages: unknown;
    try {
      messages = parseJsonc(text);
    } catch {
      continue;
    }
    writeFileSync(file, JSON.stringify(messages, null, 2) + "\n", "utf-8");
    rewritten.push(`_locales/${locale.name}/messages.json`);
  }
  return rewritten;
}

const SOURCEMAP_RE = /^[ \t]*\/\/[#@] sourceMappingURL=(\S+)[ \t]*\r?$/gm;

export function walkScripts(dir: string, acc: string[] = [], exts: string[] = [".js", ".mjs"]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith("__MACOSX")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkScripts(full, acc, exts);
    else if (entry.isFile() && exts.some((e) => entry.name.toLowerCase().endsWith(e))) acc.push(full);
  }
  return acc;
}

/**
 * Strip `//# sourceMappingURL=…` comments that point at a .map file no longer
 * present in the staged extension (stageExtension excludes *.map as dev cruft).
 * A dangling reference makes the Firefox devtools report a missing source map
 * on every load. Only strips refs whose target is gone and is a local path —
 * data: URIs (inline maps) and existing maps are left untouched. Returns the
 * number of files modified.
 */
export function stripDanglingSourcemaps(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(SOURCEMAP_RE, (whole, url: string) => {
      // data: (inline) and remote maps don't live in the package; only a local path can dangle.
      if (url.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(url)) return whole;
      // Resolve as the browser does: a leading "/" is the package root, anything
      // else is relative to the script, and a query or fragment isn't part of the file.
      let path = url.split(/[?#]/)[0];
      try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
      const mapPath = path.startsWith("/") ? join(stageDir, path) : resolve(dirname(file), path);
      if (existsSync(mapPath)) return whole;
      changed = true;
      return "";
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// Chrome bundles bake the literal scheme of their own pages into compiled
// platform tables and URL checks:
//   INTERNAL_PAGE_PROTOCOLS: ["chrome-extension:"]        (Tampermonkey)
//   sender.url.startsWith("chrome-extension://")           (common idiom)
// In Firefox every extension page is moz-extension://…, so each of these
// checks is false at runtime. The damage is silent and structural: message
// dispatchers that gate privileged methods on "is the sender one of my own
// pages?" refuse every popup/options RPC, and the page waiting on the reply
// renders nothing (Tampermonkey's action popup: loadTree refused → blank).
// A chrome-extension:// URL can never legitimately occur inside Firefox, so the
// literal is dead code unless rewritten. Swap the scheme token to Firefox's in
// the staged sources; host/path parts of any such URL are left untouched.
// Must run BEFORE the shim is written — it carries chrome-extension:// strings
// on purpose and must keep them.
//
// Token substitution, not a JS parser. Matches the scheme token
// wherever it appears (comments too — harmless). A dual-browser bundle that
// compares against BOTH schemes ends up with two equal branches; the first
// wins, same outcome either way.
//
// EXCEPT concrete-host URLs: "chrome-extension://<id>/…" (id literal or ${…}
// interpolation) is never a local check the swap can fix — Firefox's page host
// is a per-install UUID, so the host part can't match regardless of scheme.
// Such literals are server-bound tokens instead, above all OAuth redirect_uris
// registered verbatim with the provider (Claude in Chrome:
// chrome-extension://<id>/oauth_callback.html); rewriting one turns a working
// login into "Redirect URI … is not supported by client". Keep them intact.
// A wildcard host ("chrome-extension://*/…", match patterns) still rewrites —
// there the scheme is the only thing that can mismatch.
const CHROME_SCHEME_RE = /(?<![-\w])chrome-extension:(?!\/\/[\w$])/g;

function rewriteChromeSchemeLiterals(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!CHROME_SCHEME_RE.test(content)) continue;
    CHROME_SCHEME_RE.lastIndex = 0;
    writeFileSync(file, content.replace(CHROME_SCHEME_RE, "moz-extension:"), "utf-8");
    modified++;
  }
  return modified;
}

// `chrome-extension://__MSG_@@extension_id__/…` is how a bundle points at its own
// files from CSS (and from markup), because the browser resolves @@extension_id at
// load time. Firefox substitutes the placeholder with the per-install UUID but
// leaves the scheme alone, so the request goes out as chrome-extension://<uuid>/…,
// a scheme Firefox can't load: every webfont and image behind such a URL fails
// (Cloaked's content.css loses 18 webfonts on each page it injects into).
//
// CHROME_SCHEME_RE skips this (its host guard can't tell a placeholder from a real
// id), and it has to: a concrete-host URL may be an OAuth redirect_uri registered
// with the provider. A placeholder host never is — nothing outside the browser can
// resolve it — so the scheme is safe to fix here. Covers CSS, which the script-only
// rewrites never see.
const EXT_ID_PLACEHOLDER_RE = /chrome-extension:(?=\/\/__MSG_@@extension_id__\b)/g;

function rewriteExtensionIdPlaceholderUrls(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir, [], [".js", ".mjs", ".css", ".html", ".htm"])) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!content.includes("chrome-extension://__MSG_@@extension_id__")) continue;
    writeFileSync(file, content.replace(EXT_ID_PLACEHOLDER_RE, "moz-extension:"), "utf-8");
    modified++;
  }
  return modified;
}

// Bundles route extension-page ports (popup / side panel / devtools) by testing the
// sender's URL against a RegExp built from chrome.runtime.id:
//   new RegExp(chrome.runtime.id + "/src/popup.html").test(port.sender.url)
// On Chrome that works because runtime.id IS the host of every extension URL. In
// Firefox it can't: runtime.id is the add-on ID from browser_specific_settings.gecko.id
// ("…@example"), while sender.url's host is the per-install UUID — two different strings,
// and the add-on ID even contains regex metacharacters. The port is never routed → the
// bg posts no reply → the popup's init RPC never resolves (e.g. Grammarly hangs on
// "starting…").
//
// Fix at conversion time: drop the `runtime.id +` prefix so the matcher becomes
//   new RegExp("/src/popup.html").test(sender.url)
// which is host-agnostic and matches the real moz-extension URL (any UUID host, and
// tolerant of a query string — the path substring still matches). It stays
// path-specific, so popup/sidePanel/devtools matchers remain distinct and
// content-script URLs don't match.
//
// Literal substitution, not a JS parser. Targets the exact, common shape
// `new RegExp(<chrome|browser>[.|["..."]]runtime.id + "<path>")`. A bundle that built the
// pattern some other way (string concat into a var first) would need AST work — add then.
const RUNTIME_ID_URL_RE =
  /new\s+RegExp\s*\(\s*(?:chrome|browser|self|globalThis|window)?\s*(?:\.\s*chrome|\.\s*browser)?\s*\.\s*runtime\s*\.\s*id\s*\+\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/g;

function rewriteRuntimeIdUrlMatchers(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(RUNTIME_ID_URL_RE, (whole, quote: string, path: string) => {
      // Only rewrite when the appended literal looks like a URL path (starts with "/").
      // That's the port-routing idiom; anything else we leave alone to stay conservative.
      if (!path.startsWith("/")) return whole;
      changed = true;
      return "new RegExp(" + quote + path + quote + ")";
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// Chrome extension pages sit in a nested browsing context, so bundles read
// `location.ancestorOrigins[0]` to learn who framed them (e.g. "am I the top-level
// extension page?"). Firefox's popup and options pages are top-level, so
// ancestorOrigins (Firefox 148+) is an EMPTY DOMStringList — present (the `?.`
// guard passes) but [0] is undefined, and the trailing `.includes(...)` throws at
// module top level. A module that throws before it renders leaves a blank popup
// (Salesforce Inspector Reloaded: popup.js line 1 → empty popup).
//
// Guard the index read so the method call sees an empty string instead of undefined:
//   location.ancestorOrigins?.[0].includes(x)  ->  (location.ancestorOrigins?.[0] || "").includes(x)
//   location.ancestorOrigins[0].includes(x)    ->  (location.ancestorOrigins[0] || "").includes(x)
// "" is falsy and safely answers every string method (.includes/.indexOf/.startsWith
// → false/-1), matching what the check wants when there's no ancestor: "not framed".
//
// Literal substitution, not a JS parser. Matches the `.ancestorOrigins` access with an
// immediate `[0]` (optional-chained or plain) that is followed by a method call. Only that
// followed-by-`.`method shape can throw here; a bare `ancestorOrigins[0]` assigned to a var
// is left alone (already undefined-tolerant).
// The receiver of `.ancestorOrigins` is always a dotted-identifier Location chain
// (location, window.location, self.location, document.location, top.location), so the
// walk-back class is plain identifier chars + `.`/`?.`. It must NOT include `)` or `]`:
// a `)`/`]` in the class lets the match START mid-expression (e.g. at the `)` of
// `foo().ancestorOrigins…`), and the `|| ""` wrap then emits unbalanced `foo((…))` —
// a SyntaxError that kills the whole file. (Latent: real bundles never call-through to
// ancestorOrigins, but a token class must not be able to produce invalid output.)
//
// Found from the `.ancestorOrigins[0]` end and walked back, never by a pattern that
// starts with the receiver: `(?:[\w$.]|\?\.)+\.ancestorOrigins` retries from every
// position of every long word run and backtracks over the rest of it, which is
// quadratic. Floccus ships multi-megabyte runs of identifier characters (inlined
// data), and conversion sat in this step for over half an hour.
const ANCESTOR_INDEX_RE = /\.ancestorOrigins(?:\?\.\[0\]|\[0\])(?=\s*\.)/g;

/** Start of the dotted identifier chain (`a.b?.c`) that ends just before `end`. */
function receiverChainStart(src: string, end: number): number {
  let i = end;
  while (i > 0) {
    const c = src.charCodeAt(i - 1);
    const word = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 46;
    if (word) { i--; continue; }
    if (c === 63 && src.charCodeAt(i) === 46) { i--; continue; } // the "?" of "?."
    break;
  }
  return i;
}

function guardAncestorOriginsAccess(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!content.includes("ancestorOrigins")) continue;
    let out = "";
    let last = 0;
    for (let m: RegExpExecArray | null; (m = ANCESTOR_INDEX_RE.exec(content)); ) {
      const start = receiverChainStart(content, m.index);
      // `.ancestorOrigins` needs a receiver; a bare one is not this shape. A chain
      // that starts with "." or "?." continues a call or index to its left
      // (`frames[0].location…`, `f()?.location…`), which the walk can't take in,
      // and wrapping from the dot would emit `frames[0](.location… || "")`, a
      // SyntaxError that kills the whole file. Leave those as they are.
      if (start === m.index || start < last) continue;
      const lead = content.charCodeAt(start);
      if (lead === 46 || lead === 63) continue;
      const end = m.index + m[0].length;
      out += content.slice(last, start) + "(" + content.slice(start, end) + ' || "")';
      last = end;
    }
    if (last > 0) {
      writeFileSync(file, out + content.slice(last), "utf-8");
      modified++;
    }
  }
  return modified;
}

// A bundle recognizes its OWN pages by rebuilding their origin out of runtime.id and
// comparing it to a port's sender:
//   new URL(port.sender.url).origin === `chrome-extension://${chrome.runtime.id}`
// On Chrome that holds, because runtime.id is the host of every extension URL. In
// Firefox it can't: runtime.id is the add-on ID while the page's host is the
// per-install UUID (see rewriteRuntimeIdUrlMatchers for the RegExp form of the same
// idiom). MetaMask is the case where this decides everything: its background answers
// a port's liveness ping unconditionally but only sends BACKGROUND_INITIALIZED to a
// port it believes is its own UI, so with the comparison false the popup gets the
// ping, waits 16 s for the init message that never comes, and shows "MetaMask had
// trouble starting — Background initialization timeout".
//
// So derive the origin from getURL instead of from runtime.id. `new URL()` normalizes
// the host on both sides, and the rewritten expression means exactly the same thing
// on Chrome.
//
// Only an origin-ONLY literal is rewritten: nothing may follow the interpolation
// inside the template. A concrete-host URL WITH a path is usually a server-bound
// token — above all an OAuth redirect_uri registered verbatim with the provider —
// and rewriting one breaks the login (the reason CHROME_SCHEME_RE skips these too).
// The namespace chain allows empty calls (`C().runtime.id`, minifier-emitted) and
// dotted steps, but no call arguments: a quote or paren inside the class could let a
// match start mid-expression and emit unbalanced output.
//
// `.runtime.id` itself must be plain-dotted. An optional-chained `browser?.runtime?.id`
// evaluates to undefined instead of throwing when the namespace is missing, and the
// replacement — which has to call getURL and hand the result to new URL() — cannot
// reproduce that, so those are left alone rather than given new throw behavior.
const NS_CHAIN = "[A-Za-z_$][\\w$]*(?:\\s*\\(\\s*\\)|\\s*\\??\\.\\s*[\\w$]+)*";
const EXT_ORIGIN_TEMPLATE_RE = new RegExp(
  "`chrome-extension://\\$\\{\\s*(" + NS_CHAIN + ")\\s*\\.\\s*runtime\\s*\\.\\s*id\\s*\\}`",
  "g",
);
const EXT_ORIGIN_CONCAT_RE = new RegExp(
  "([\"'])chrome-extension://\\1\\s*\\+\\s*(" + NS_CHAIN + ")\\s*\\.\\s*runtime\\s*\\.\\s*id\\b",
  "g",
);

function rewriteExtensionOriginFromRuntimeId(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!content.includes("chrome-extension://")) continue;
    let changed = false;
    const origin = (ns: string): string => {
      changed = true;
      return 'new URL(' + ns + '.runtime.getURL("/")).origin';
    };
    const next = content
      .replace(EXT_ORIGIN_TEMPLATE_RE, (_whole, ns: string) => origin(ns))
      .replace(EXT_ORIGIN_CONCAT_RE, (_whole, _q: string, ns: string) => origin(ns));
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// A template literal whose ENTIRE value is `chrome-extension://${<ext-id>}/<path>` is a
// self-page navigation (fed to tabs.create / window.open / location=), NOT an OAuth
// redirect_uri. rewriteChromeSchemeLiterals deliberately skips `chrome-extension://${…}`
// to preserve redirect_uris registered with the provider — but that also skips these real
// navigations, which then point at a scheme+host that don't exist in Firefox (the scheme is
// moz-extension:// and the host is a per-install UUID, not the add-on ID). Result:
// Salesforce Inspector's keyboard-command page opens (data-export, options, …) land on a
// dead chrome-extension://<id>/foo.html tab.
//
// Rewrite them to chrome.runtime.getURL(`<path>`), which resolves to the correct
// moz-extension scheme + UUID host at runtime. Safe because we ONLY match when the backtick
// immediately precedes `chrome-extension://` (the literal IS the whole URL) and the host is
// an extension-id expression — so an embedded redirect_uri like `…redirect_uri=${browser}-
// extension://…` inside a larger authorize URL never matches (its scheme is interpolated,
// and it isn't at the start of the literal).
//
// Host expr covered: chrome.i18n.getMessage("@@extension_id"), (chrome|browser).runtime.id.
const SELF_PAGE_URL_RE =
  /`chrome-extension:\/\/\$\{\s*(?:(?:chrome|browser)\s*\.\s*i18n\s*\.\s*getMessage\s*\(\s*(["'])@@extension_id\1\s*\)|(?:chrome|browser)\s*\.\s*runtime\s*\.\s*id)\s*\}\/([^`]*)`/g;

function rewriteSelfPageExtensionUrls(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(SELF_PAGE_URL_RE, (_whole, _q, path: string) => {
      changed = true;
      return "chrome.runtime.getURL(`" + path + "`)";
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// MV3 bundles decide "am I the background?" by the absence of `window`, because in Chrome
// the background is a service worker. Firefox runs the converted worker as background
// scripts in an event page — which HAS a window, so the check says no and the bundle
// concludes it is a content script. Anything keyed off that identity then misroutes
// silently: no error, no log, just a promise that never settles. Cloaked's crx-kit
// dispatcher opens with `if (msg.to !== this.myEndpoint) return false`, and with its
// background reporting FOREGROUND, clicking "Log in" delivered
// {to:"BACKGROUND", name:"openAuthUrl"} to a listener that dropped it on the floor, and
// the popup spun forever.
//
// Only rewritten inside the files the background itself loads, and only where the check
// directly produces a background-ish value — so a bundled library using the same idiom to
// pick a Node path, or the identical detector inside the POPUP bundle (which must keep
// answering "foreground"), is never touched.
const WINDOW_IS_UNDEFINED = [
  String.raw`void\s+0\s*===?\s*(?:globalThis\.|self\.)?window`,
  String.raw`(?:globalThis\.|self\.)?window\s*===?\s*void\s+0`,
  String.raw`typeof\s+(?:globalThis\.|self\.)?window\s*===?\s*(?:"undefined"|'undefined')`,
  String.raw`(?:"undefined"|'undefined')\s*===?\s*typeof\s+(?:globalThis\.|self\.)?window`,
  // terser shorthand: a type string sorts after "u" only when it is "undefined"
  String.raw`typeof\s+(?:globalThis\.|self\.)?window\s*>\s*(?:"u"|'u')`,
].join("|");

const BACKGROUND_LITERAL =
  String.raw`(?:"|')(?:background|background_script|backgroundScript|background-script|service_worker|serviceWorker|sw)(?:"|')`;

/** `if (typeof window === "undefined") return "background_script"` */
const BG_CHECK_RETURN_RE = new RegExp(
  // `return` may butt straight against the quote — minifiers emit `return"background"`.
  String.raw`(\bif\s*\(\s*)(?:${WINDOW_IS_UNDEFINED})(\s*\)\s*\{?\s*return\s*${BACKGROUND_LITERAL})`,
  "g",
);

/** `typeof window === "undefined" ? "background" : …` */
const BG_CHECK_TERNARY_RE = new RegExp(
  String.raw`(?:${WINDOW_IS_UNDEFINED})(\s*\?\s*${BACKGROUND_LITERAL})`,
  "g",
);

/** Absolute paths of the staged scripts the background context loads. */
function backgroundScriptPaths(stageDir: string, manifest: Manifest): string[] {
  const rel: string[] = [];
  const sw = manifest.background?.service_worker;
  if (typeof sw === "string") rel.push(sw);
  for (const s of manifest.background?.scripts ?? []) if (typeof s === "string") rel.push(s);
  return rel
    .map((r) => join(stageDir, r.replace(/^\.?\//, "")))
    .filter((p) => existsSync(p));
}

function rewriteBackgroundContextChecks(stageDir: string, manifest: Manifest): number {
  let modified = 0;
  for (const file of backgroundScriptPaths(stageDir, manifest)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    // The file IS the background, page or worker, so the check's answer is
    // unconditionally yes.
    const next = content
      .replace(BG_CHECK_RETURN_RE, "$1true$2")
      .replace(BG_CHECK_TERNARY_RE, "true$1");
    if (next !== content) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// A worker gives itself a window with `self.window = self`. In the event page that
// replaces it, window is a getter-only accessor, and the assignment throws in
// strict code, ending the script there. window already is the global in a page.
const WINDOW_SELF_ALIAS_RE = /(^|[^.\w$])(?:self|globalThis)\s*\.\s*window\s*=\s*(self|globalThis)\b(?!\s*[.[(=])/g;

function rewriteWorkerWindowAlias(stageDir: string, manifest: Manifest): number {
  if (typeof manifest.background?.service_worker !== "string") return 0;
  let modified = 0;
  for (const file of backgroundScriptPaths(stageDir, manifest)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const next = content.replace(WINDOW_SELF_ALIAS_RE, "$1$2");
    if (next !== content) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// lodash and webpack find the global object with `freeGlobal || freeSelf ||
// Function("return this")()`. In a Firefox content script `self` is an Xray to
// the page's window (self.Object !== Object), so the lookup falls through to
// Function(), which the content-script CSP refuses; Chrome's isolated world
// passes the `self` test. The call can only return its realm's global.
const FUNCTION_RETURN_THIS_RE = /(?<![\w$.])(?:new\s+)?Function\s*\(\s*(["'])return this;?\1\s*\)\s*\(\s*\)/g;

function rewriteFunctionGlobalLookups(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const next = content.replace(FUNCTION_RETURN_THIS_RE, "globalThis");
    if (next !== content) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// Firefox refuses to run a moz-extension: file as a script unless its name ends in
// an extension its built-in MIME table maps to JavaScript: .js, .mjs or .jsm, in any
// case (nsContentSecurityManager's CheckAllowExtensionProtocolScriptLoad, MV3 add-ons
// only). The console says "Loading script with URI … was blocked because the file
// extension is not allowed." Chrome runs any name, and Google's own Save to Google
// Drive loads js/rpc.js.compiled from its options page. The check covers every
// script load: <script src>, content_scripts js, background scripts, importScripts,
// new Worker, static and dynamic import, and scripting.executeScript files.
//
// Give each such script a copy named <name>.js and point the references that can be
// rewritten without a parser at it: the manifest's content_scripts js, background
// scripts and service_worker; <script src> in the pages; literal string arguments to
// importScripts, new Worker and new SharedWorker; and relative import specifiers.
// Appending keeps a reference's query and fragment and its relative form valid.
// scripting.executeScript `files` stay as they are: a regex can't tell them from
// insertCSS `files`, and renaming a stylesheet there breaks its injection. The
// original stays when its name still turns up in a staged file or the manifest
// (an executeScript file, a getURL, a fetch, a web-accessible resource).
const SCRIPT_FILE_EXT_RE = /\.(?:js|mjs|jsm)$/i;
const HTML_SCRIPT_TAG_RE = /<script\b[^>]*>/gi;
const TAG_SRC_RE = /(\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/i;
const TAG_TYPE_RE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/i;
const JS_SCRIPT_TYPES: Record<string, true> = {
  "": true,
  module: true,
  "text/javascript": true,
  "application/javascript": true,
  "text/ecmascript": true,
  "application/ecmascript": true,
  "application/x-javascript": true,
};
const SCRIPT_LOAD_CALL_RE = /\b(?:importScripts|Worker|SharedWorker)\s*\(([^)]*)\)/g;
const SCRIPT_LOAD_IMPORT_RE = /(\bimport\s*\(?\s*|\bfrom\s*)("(\.{0,2}\/[^"\n]*)"|'(\.{0,2}\/[^'\n]*)')/g;
// JSON and CSS modules load as data, not script, and need their own names.
const DATA_MODULE_RE = /\.(?:json|css)(?:[?#]|$)/i;

function renameNonJsScripts(stageDir: string, manifest: Manifest): number {
  if ((manifest.manifest_version ?? 2) < 3) return 0;
  const exists = (rel: string) => {
    try { return statSync(join(stageDir, rel)).isFile(); } catch { return false; }
  };
  const needsName = (rel: string) => !SCRIPT_FILE_EXT_RE.test(posix.basename(rel)) && !exists(`${rel}.js`);
  const resolveRef = (fromRel: string, ref: string) => candidatePaths(fromRel, ref).find(exists);
  const isPage = (rel: string) => PAGE_EXTS.some((e) => rel.toLowerCase().endsWith(e));
  const withJs = (ref: string) => {
    const cut = ref.search(/[?#]/);
    return cut < 0 ? `${ref}.js` : `${ref.slice(0, cut)}.js${ref.slice(cut)}`;
  };

  // Each reference a file makes in a script-load position, with the rewrite that
  // points the matched text at the renamed copy when `rename(ref)` returns true.
  const rewriteRefs = (rel: string, text: string, rename: (ref: string) => boolean): string => {
    const literals = (args: string) =>
      args.replace(STRING_LITERAL_RE, (lit, d?: string, s?: string, b?: string) => {
        const v = d ?? s ?? b ?? "";
        return v && rename(v) ? lit[0] + withJs(v) + lit[0] : lit;
      });
    if (isPage(rel)) {
      return text.replace(HTML_SCRIPT_TAG_RE, (tag) => {
        const type = TAG_TYPE_RE.exec(tag);
        if (type && !JS_SCRIPT_TYPES[(type[1] ?? type[2] ?? type[3] ?? "").trim().toLowerCase()]) return tag;
        return tag.replace(TAG_SRC_RE, (whole, attr: string, d?: string, s?: string, u?: string) => {
          const v = d ?? s ?? u ?? "";
          if (!v || !rename(v)) return whole;
          const q = d !== undefined ? '"' : s !== undefined ? "'" : "";
          return attr + q + withJs(v) + q;
        });
      });
    }
    return text
      // The argument list is the group right before the closing ")".
      .replace(SCRIPT_LOAD_CALL_RE, (whole, args: string) => whole.slice(0, whole.length - args.length - 1) + literals(args) + ")")
      .replace(SCRIPT_LOAD_IMPORT_RE, (whole, lead: string, lit: string, d?: string, s?: string) => {
        const v = d ?? s ?? "";
        return DATA_MODULE_RE.test(v) || !rename(v) ? whole : lead + lit[0] + withJs(v) + lit[0];
      });
  };

  // Which files are loaded as scripts, followed through the scripts found.
  const targets = new Set<string>();
  const declared: string[] = [];
  for (const cs of Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []) {
    if (Array.isArray(cs?.js)) declared.push(...cs.js.filter((p: unknown): p is string => typeof p === "string"));
  }
  if (Array.isArray(manifest.background?.scripts)) declared.push(...manifest.background.scripts.filter((p): p is string => typeof p === "string"));
  if (typeof manifest.background?.service_worker === "string") declared.push(manifest.background.service_worker);
  for (const p of declared) {
    const rel = resolveRef("", p);
    if (rel && needsName(rel)) targets.add(rel);
  }
  const sources: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.isFile() && (isPage(r) || SCRIPT_FILE_EXT_RE.test(e.name))) sources.push(r);
    }
  };
  walk(stageDir, "");
  const queue = [...sources, ...targets];
  const scanned = new Set<string>();
  while (queue.length > 0) {
    const rel = queue.pop() as string;
    if (scanned.has(rel)) continue;
    scanned.add(rel);
    let text: string;
    try { text = readFileSync(join(stageDir, rel), "utf-8"); } catch { continue; }
    rewriteRefs(rel, text, (ref) => {
      const target = resolveRef(rel, ref);
      if (target && needsName(target) && !targets.has(target)) {
        targets.add(target);
        queue.push(target);
      }
      return false;
    });
  }
  if (targets.size === 0) return 0;

  for (const rel of targets) copyFileSync(join(stageDir, rel), join(stageDir, `${rel}.js`));
  const renamed = (fromRel: string) => (ref: string) => {
    const target = resolveRef(fromRel, ref);
    return target !== undefined && targets.has(target);
  };
  for (const rel of [...scanned].map((r) => (targets.has(r) ? `${r}.js` : r))) {
    let text: string;
    try { text = readFileSync(join(stageDir, rel), "utf-8"); } catch { continue; }
    const next = rewriteRefs(rel, text, renamed(rel));
    if (next !== text) writeFileSync(join(stageDir, rel), next, "utf-8");
  }
  const fix = <T>(p: T): T => (typeof p === "string" && renamed("")(p) ? (withJs(p) as T) : p);
  for (const cs of Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []) {
    if (Array.isArray(cs?.js)) cs.js = cs.js.map(fix);
  }
  if (manifest.background) {
    if (Array.isArray(manifest.background.scripts)) manifest.background.scripts = manifest.background.scripts.map(fix);
    if (typeof manifest.background.service_worker === "string") manifest.background.service_worker = fix(manifest.background.service_worker);
  }

  // Drop an original nothing names any more. Its new name starts with the old one,
  // so only a mention not followed by ".js" counts.
  const texts: string[] = [JSON.stringify(manifest)];
  const walkAll = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walkAll(full);
      else if (e.isFile() && /\.(?:html?|xhtml|m?js|jsm|css|json)$/i.test(e.name)) {
        try { texts.push(readFileSync(full, "utf-8")); } catch { /* unreadable: nothing to find */ }
      }
    }
  };
  walkAll(stageDir);
  for (const rel of targets) {
    const base = posix.basename(rel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mention = new RegExp(`${base}(?!\\.js)`);
    if (!texts.some((t) => mention.test(t))) rmSync(join(stageDir, rel), { force: true });
  }
  return targets.size;
}

/**
 * Run every source rewrite over the staged scripts, in dependency order: the
 * runtime.id rewrites and the self-page rewrite need to see `chrome-extension://`
 * before or around the scheme swap exactly as they do here. Returns one entry
 * per rewrite, phrased to read as "<name> in <count> file(s)"; entries with a
 * zero count did nothing.
 */
export function applySourceRewrites(stageDir: string, manifest: Manifest): Array<{ name: string; count: number }> {
  return [
    // First, so every later pass (and the background lookups) sees the new names.
    { name: "Gave scripts without a .js extension a name Firefox loads", count: renameNonJsScripts(stageDir, manifest) },
    { name: "Rewrote runtime.id-based port matchers", count: rewriteRuntimeIdUrlMatchers(stageDir) },
    { name: "Rewrote runtime.id-based extension-origin checks", count: rewriteExtensionOriginFromRuntimeId(stageDir) },
    { name: "Rewrote chrome-extension: scheme literals", count: rewriteChromeSchemeLiterals(stageDir) },
    { name: "Rewrote self-page chrome-extension: URLs to runtime.getURL", count: rewriteSelfPageExtensionUrls(stageDir) },
    { name: "Rewrote @@extension_id placeholder URLs", count: rewriteExtensionIdPlaceholderUrls(stageDir) },
    { name: "Corrected the background-context check", count: rewriteBackgroundContextChecks(stageDir, manifest) },
    { name: "Dropped the worker's self.window alias, which an event page refuses", count: rewriteWorkerWindowAlias(stageDir, manifest) },
    { name: "Guarded location.ancestorOrigins[0] reads", count: guardAncestorOriginsAccess(stageDir) },
    { name: 'Replaced Function("return this")() global lookups with globalThis', count: rewriteFunctionGlobalLookups(stageDir) },
  ];
}
