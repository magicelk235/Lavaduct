import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import type { Manifest } from "../types.js";
import { TEMPLATE_DIR } from "../paths.js";
import { NAME } from "../name.js";
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
 * extension. Chrome gives those pages `chrome.runtime.sendMessage(<id>, …)` and
 * delivers to the extension's `runtime.onMessageExternal` listeners; Firefox
 * ignores the key and gives web pages no `chrome.runtime` at all. This stages
 * three scripts and wires them in:
 *   - a page-world content script that provides `chrome.runtime.sendMessage`;
 *   - an isolated-world relay that carries each message to the background;
 *   - a background receiver, loaded ahead of the extension's own background code,
 *     that hands the message to the captured onMessageExternal listeners with the
 *     page as the sender.
 * The `externally_connectable` key is removed once the bridge replaces it.
 *
 * Works whether the background is still a service worker (the receiver is
 * imported by it, so wireBackground puts it ahead of the worker) or has already
 * been wired as `background.scripts` or a `page`. Mutates `manifest`; returns
 * notes for the report.
 */
export function applyOAuthBridge(stageDir: string, manifest: Manifest, chromeId?: string): string[] {
  const raw = manifest.externally_connectable?.matches;
  const matches = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string" && m.length > 0) : [];
  if (matches.length === 0) return [];
  const bg = manifest.background;
  if (!bg || (typeof bg.service_worker !== "string" && !Array.isArray(bg.scripts) && typeof bg.page !== "string")) {
    return ["Page bridge skipped: the extension has no background to receive messages from externally_connectable pages."];
  }

  // Derived rather than random so the packed add-on is identical between runs.
  const channel = createHash("sha256")
    .update(JSON.stringify([chromeId ?? "", manifest.name ?? "", matches]))
    .digest("hex")
    .slice(0, 16);
  for (const [staged, template] of Object.entries(TEMPLATES)) {
    let src = readFileSync(join(TEMPLATE_DIR, template), "utf-8").split(CHANNEL_PLACEHOLDER).join(channel);
    if (chromeId) src = src.split(EXT_ID_PLACEHOLDER).join(chromeId);
    writeFileSync(join(stageDir, staged), src, "utf-8");
  }

  wireReceiver(stageDir, manifest);

  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  if (!scripts.some((cs) => Array.isArray(cs.js) && cs.js.includes(BRIDGE_PAGE))) {
    scripts.unshift(
      { js: [BRIDGE_PAGE], matches, run_at: "document_start", all_frames: false, world: "MAIN" },
      { js: [BRIDGE_PAGE_CS], matches, run_at: "document_start", all_frames: false },
    );
  }
  manifest.content_scripts = scripts;
  delete manifest.externally_connectable;
  return [`Page bridge wired for externally_connectable pages: ${matches.join(", ")}`];
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
