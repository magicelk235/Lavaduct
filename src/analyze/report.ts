import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Issue, Manifest, Severity } from "../types.js";
import { cspLocalhostSources, cspWildcardHostPaths, withoutPortWildcard } from "../manifest/manifest.js";
import { color } from "../util.js";

/**
 * Human-readable list of what transformManifest() changed, original → transformed.
 * Lets `--analyze` preview the real manifest rewrites (not just compatibility
 * issues) without writing anything. Covers the fields the converter actually
 * touches; intentionally not a full deep diff.
 */
export function summarizeManifestChanges(before: Manifest, after: Manifest): string[] {
  const out: string[] = [];

  for (const key of ["update_url", "key", "minimum_chrome_version"] as const) {
    if (before[key] !== undefined && after[key] === undefined) out.push(`Dropped \`${key}\` (Chrome-only).`);
  }

  if (before.version !== after.version) out.push(`Version ${before.version === undefined ? "(none)" : `\`${before.version}\``} → \`${after.version}\` (Firefox format).`);

  // A malformed manifest can set permissions to a non-array (a bare string,
  // an object); guard with Array.isArray so .filter()/.includes() never throw
  // and abort the --analyze run, matching the array guards used elsewhere.
  const permList = (m: Manifest, key: "permissions" | "optional_permissions"): string[] =>
    Array.isArray(m[key]) ? (m[key] as string[]) : [];
  const [required, optional] = [permList(before, "permissions"), permList(before, "optional_permissions")];
  const [requiredAfter, optionalAfter] = [permList(after, "permissions"), permList(after, "optional_permissions")];
  // Firefox reads some permissions from only one of the two lists, so the transform
  // moves them across; that keeps the permission and must not read as a removal.
  const toRequired = optional.filter((p) => !required.includes(p) && requiredAfter.includes(p));
  const toOptional = required.filter((p) => !optional.includes(p) && optionalAfter.includes(p));
  const quoted = (list: string[]) => list.map((p) => `\`${p}\``).join(", ");
  if (toRequired.length) out.push(`Moved ${quoted(toRequired)} from \`optional_permissions\` to \`permissions\` (Firefox only grants ${toRequired.length > 1 ? "them" : "it"} at install).`);
  if (toOptional.length) out.push(`Moved ${quoted(toOptional)} from \`permissions\` to \`optional_permissions\` (Firefox only grants ${toOptional.length > 1 ? "them" : "it"} at runtime).`);

  // A pattern that only lost its port wildcard is kept, not removed.
  const removedPerms = required.filter((p) => !requiredAfter.includes(withoutPortWildcard(p)) && !toOptional.includes(p));
  if (removedPerms.length) out.push(`Removed permission(s): ${quoted(removedPerms)}.`);

  const removedOptPerms = optional.filter((p) => !optionalAfter.includes(withoutPortWildcard(p)) && !toRequired.includes(p));
  if (removedOptPerms.length) out.push(`Removed optional permission(s): ${quoted(removedOptPerms)}.`);

  // Permissions the converter grants for an emulation (chrome.debugger runs on
  // scripting, tabs, webNavigation and webRequest; frames of bridged sites on
  // blocking webRequest and a session rule), host patterns aside.
  const addedPerms = requiredAfter.filter((p) => !required.includes(p) && !toRequired.includes(p) && p !== "<all_urls>" && !p.includes("://"));
  if (addedPerms.length) out.push(`Added permission(s) ${quoted(addedPerms)}, which the converter's emulations run on.`);

  const ported: string[] = [];
  for (const key of ["permissions", "optional_permissions", "host_permissions", "optional_host_permissions"] as const) {
    const beforeHosts = Array.isArray(before[key]) ? (before[key] as unknown[]).filter((p): p is string => typeof p === "string") : [];
    const afterHosts = Array.isArray(after[key]) ? (after[key] as unknown[]).filter((p): p is string => typeof p === "string") : [];
    for (const p of beforeHosts) if (withoutPortWildcard(p) !== p && afterHosts.includes(withoutPortWildcard(p))) ported.push(p);
    if (key === "optional_permissions") continue;
    const removed = key === "permissions" ? [] : beforeHosts.filter((p) => !afterHosts.includes(withoutPortWildcard(p)));
    if (removed.length) out.push(`Removed \`${key}\` pattern(s): ${removed.map((p) => `\`${p}\``).join(", ")}.`);
    const beforeFixed = beforeHosts.map(withoutPortWildcard);
    const added = afterHosts.filter((p) => (p === "<all_urls>" || p.includes("://")) && !beforeFixed.includes(p));
    if (added.length) {
      const why = added.includes("<all_urls>")
        ? "the chrome.debugger emulation needs access to every page"
        : "the add-on's own pages frame these sites, and the page bridge needs access to them";
      out.push(`Added \`${key}\` pattern(s) ${added.map((p) => `\`${p}\``).join(", ")}: ${why}.`);
    }
  }
  if (ported.length) out.push(`Dropped the port wildcard from ${quoted(ported)} (Firefox has none; a pattern without a port matches every port).`);

  const gecko = after.browser_specific_settings?.gecko;
  if (gecko && JSON.stringify(gecko) !== JSON.stringify(before.browser_specific_settings?.gecko)) {
    const parts: string[] = [];
    if (gecko.id) parts.push(`id \`${gecko.id}\``);
    if (gecko.strict_min_version) parts.push(`strict_min_version \`${gecko.strict_min_version}\``);
    const required = gecko.data_collection_permissions?.required;
    if (Array.isArray(required)) parts.push(`data_collection_permissions.required \`${required.join(", ")}\``);
    out.push(`Set \`browser_specific_settings.gecko\`${parts.length ? `: ${parts.join(", ")}` : ""}.`);
  } else if (!gecko && before.browser_specific_settings?.gecko) {
    out.push("Removed `browser_specific_settings.gecko` (Android-only build).");
  }
  if (after.browser_specific_settings?.gecko_android && !before.browser_specific_settings?.gecko_android)
    out.push("Added `browser_specific_settings.gecko_android` (enables Firefox for Android).");

  if (before.background?.service_worker && !after.background?.service_worker && Array.isArray(after.background?.scripts))
    out.push(`Converted \`background.service_worker\` into \`background.scripts\` (Firefox event page).`);

  if (before.side_panel && !after.side_panel && after.sidebar_action) {
    const panel = after.sidebar_action.default_panel;
    out.push(`Mapped \`side_panel\` to \`sidebar_action\`${panel ? ` → \`${panel}\`` : ""} (not opened on install).`);
  } else if (!before.side_panel && !before.sidebar_action && after.sidebar_action) {
    const panel = after.sidebar_action.default_panel;
    out.push(`Added \`sidebar_action\`${panel ? ` → \`${panel}\`` : ""} for the page the extension opens with chrome.sidePanel (not opened on install).`);
  }

  if (before.incognito === "split" && after.incognito === undefined)
    out.push('Removed `incognito: "split"` (Firefox would fall back to not_allowed; the default is spanning).');

  const sandboxCsp = (m: Manifest): unknown =>
    typeof m.content_security_policy === "object" ? m.content_security_policy.sandbox : (m.sandbox as Record<string, unknown> | undefined)?.content_security_policy;
  if (sandboxCsp(before) === undefined && sandboxCsp(after) !== undefined)
    out.push("Added Chrome's default sandbox CSP (Firefox would apply script-src 'self' to the sandbox pages, blocking eval and inline scripts).");

  const cspSources = (m: Manifest): string[] => {
    const csp = m.content_security_policy;
    const sandbox = (m.sandbox as Record<string, unknown> | undefined)?.content_security_policy;
    const all = [...(typeof csp === "string" ? [csp] : Object.values(csp ?? {})), sandbox].filter((p): p is string => typeof p === "string");
    return all.flatMap(cspWildcardHostPaths);
  };
  const cspPorted = [...new Set(cspSources(before))].filter((s) => !cspSources(after).includes(s));
  if (cspPorted.length) out.push(`Wrote the default port after the wildcard host in CSP source(s) ${quoted(cspPorted)} (Firefox drops a wildcard host followed by a path).`);

  const pagesCsp = (m: Manifest): string => {
    const csp = m.content_security_policy;
    return (m.manifest_version ?? 2) >= 3 && typeof csp === "object" && typeof csp.extension_pages === "string" ? csp.extension_pages : "";
  };
  const localhost = cspLocalhostSources(pagesCsp(before)).filter((s) => !cspLocalhostSources(pagesCsp(after)).includes(s));
  if (localhost.length) out.push(`Removed the local development server source(s) ${quoted(localhost)} from \`content_security_policy.extension_pages\` (Firefox drops the whole policy over them on install).`);

  const omniboxKeyword = (m: Manifest): unknown => (typeof m.omnibox === "object" && m.omnibox !== null ? Reflect.get(m.omnibox, "keyword") : undefined);
  const keywordBefore = omniboxKeyword(before);
  if (typeof keywordBefore === "string" && keywordBefore !== omniboxKeyword(after)) {
    const keywordAfter = omniboxKeyword(after);
    out.push(
      typeof keywordAfter === "string"
        ? `Changed the omnibox keyword \`${keywordBefore}\` to \`${keywordAfter}\` (Firefox refuses whitespace, colons and a leading "?" in it).`
        : `Removed \`omnibox\`: Firefox can't take the keyword \`${keywordBefore}\`.`,
    );
  }

  const overridesBefore = before.chrome_url_overrides;
  if (overridesBefore && typeof overridesBefore === "object") {
    const kept = after.chrome_url_overrides ?? {};
    const dropped = Object.keys(overridesBefore).filter((k) => !(k in kept));
    if (dropped.length) out.push(`Removed \`chrome_url_overrides\` ${dropped.map((k) => `\`${k}\``).join(", ")} (Firefox only lets add-ons replace the new tab page).`);
  }

  if (Array.isArray(before.web_accessible_resources) && Array.isArray(after.web_accessible_resources)) {
    const hasDynamicUrl = (list: unknown[]) =>
      list.some((e) => !!e && typeof e === "object" && "use_dynamic_url" in (e as Record<string, unknown>));
    if (hasDynamicUrl(before.web_accessible_resources) && !hasDynamicUrl(after.web_accessible_resources))
      out.push("Dropped `use_dynamic_url` from `web_accessible_resources` (unsupported in Firefox).");
  }

  // Scripts the converter put in front of the author's content scripts (the shim,
  // the page bridge), reported once rather than per content_scripts entry.
  const csJs = (m: Manifest): string[] =>
    (Array.isArray(m.content_scripts) ? m.content_scripts : []).flatMap((cs) => (Array.isArray(cs?.js) ? cs.js : []));
  const beforeJs = new Set(csJs(before));
  const addedJs = [...new Set(csJs(after).filter((j) => !beforeJs.has(j)))];
  if (addedJs.length) out.push(`Added ${addedJs.map((j) => `\`${j}\``).join(", ")} ahead of the content scripts.`);

  return out;
}

const ORDER: Severity[] = ["error", "warning", "info"];
const LABEL: Record<Severity, string> = { error: "ERROR", warning: "WARN", info: "INFO" };
const HUE: Record<Severity, "red" | "yellow" | "blue"> = { error: "red", warning: "yellow", info: "blue" };

// When `strict` is provided, append a convertible/blocking verdict line matching the
// markdown report and the exit code, so `--analyze` terminal output agrees with both
// and --strict has a visible effect. Omit it (mid-pipeline convert calls) for no verdict.
export function printIssues(issues: Issue[], strict?: boolean): void {
  const verdict = () => {
    if (strict === undefined) return;
    const blocking = countBlocking(issues, strict);
    console.log(
      blocking === 0
        ? color("green", "\nConvertible: no blocking issues.")
        : color("red", `\n${blocking} blocking issue(s)${strict ? " (--strict: warnings count as blocking)" : ""}.`),
    );
  };
  if (issues.length === 0) {
    console.log(color("green", "No compatibility issues found."));
    verdict();
    return;
  }
  const bySeverity: Record<Severity, Issue[]> = { error: [], warning: [], info: [] };
  let autoFixed = 0;
  let shimmed = 0;
  for (const i of issues) {
    bySeverity[i.severity].push(i);
    if (i.shimmed) shimmed++;
    else if (i.autoFixed) autoFixed++;
  }
  for (const sev of ORDER) {
    const group = bySeverity[sev];
    if (group.length === 0) continue;
    console.log(`\n${color(HUE[sev], `${LABEL[sev]} (${group.length})`)}`);
    for (const i of group) {
      const loc = i.file ? color("dim", ` ${i.file}${i.line ? `:${i.line}` : ""}`) : "";
      // A shimmed issue is the strongest reassurance ("still works at runtime"),
      // so prefer that badge over the generic [auto-fixed] when both apply.
      const badge = i.shimmed
        ? color("green", " [shimmed]")
        : i.autoFixed
        ? color("green", " [auto-fixed]")
        : "";
      console.log(`  • [${i.category}]${loc}${badge}`);
      console.log(`    ${i.message}`);
      if (i.fix && !i.autoFixed) console.log(color("dim", `    fix: ${i.fix}`));
      else if (i.fix && i.autoFixed) console.log(color("dim", `    ${i.fix}`));
    }
  }
  const parts = ORDER.map((sev) => {
    const n = bySeverity[sev].length;
    if (!n) return null;
    const word = sev === "info" ? "info" : n > 1 ? `${sev}s` : sev;
    return color(HUE[sev], `${n} ${word}`);
  }).filter(Boolean);
  const tally = [
    autoFixed ? `${autoFixed} auto-fixed` : null,
    shimmed ? `${shimmed} shimmed` : null,
  ].filter(Boolean);
  console.log(`\n${parts.join(color("dim", " · "))}${tally.length ? color("green", ` (${tally.join(", ")})`) : ""}`);
  verdict();
}

export function countBlocking(issues: Issue[], strict = false): number {
  return issues.filter(
    (i) => !i.autoFixed && (i.severity === "error" || (strict && i.severity === "warning"))
  ).length;
}

const HEADING: Record<Severity, string> = { error: "Errors", warning: "Warnings", info: "Info" };

export interface ReportMeta {
  name: string;
  version?: string;
  manifestVersion: number;
  platforms: string;
  removedPermissions?: string[];
  /** Human-readable manifest rewrites (from summarizeManifestChanges). */
  manifestChanges?: string[];
  /** --strict: count warnings as blocking, so the status matches the exit code. */
  strict?: boolean;
}

/** Build the Markdown conversion report as a string (no I/O). */
export function buildReportMarkdown(meta: ReportMeta, issues: Issue[]): string {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  let autoFixed = 0;
  let shimmed = 0;
  for (const i of issues) {
    counts[i.severity]++;
    if (i.shimmed) shimmed++;
    else if (i.autoFixed) autoFixed++;
  }

  // Blocking = unresolved errors (auto-fixed ones don't block); same gate the
  // converter and --analyze use, so the verdict here agrees with the exit code.
  const blocking = countBlocking(issues, meta.strict);
  // Mirror the terminal verdict's wording: under --strict the blocking count
  // includes promoted warnings, so calling them all "error(s)" contradicts the
  // per-severity counts a few lines below.
  const status = blocking === 0
    ? "Convertible, no blocking issues"
    : `${blocking} blocking issue(s)${meta.strict ? " (--strict: warnings count as blocking)" : ""}. Use --force to convert anyway`;

  const lines: string[] = [
    `# Conversion report: ${meta.name}`,
    "",
    `- Status: ${status}`,
    `- Version: ${meta.version ?? "(none)"}`,
    `- Manifest: MV${meta.manifestVersion}`,
    `- Platforms: ${meta.platforms}`,
    `- Issues: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info` +
      (autoFixed ? `, ${autoFixed} auto-fixed` : "") +
      (shimmed ? `, ${shimmed} shimmed` : ""),
    "",
  ];

  if (meta.removedPermissions && meta.removedPermissions.length > 0) {
    lines.push(`## Removed permissions (${meta.removedPermissions.length})`, "");
    for (const p of meta.removedPermissions) lines.push(`- \`${p}\``);
    lines.push("");
  }

  if (meta.manifestChanges && meta.manifestChanges.length > 0) {
    lines.push(`## Manifest changes (${meta.manifestChanges.length})`, "");
    for (const c of meta.manifestChanges) lines.push(`- ${c}`);
    lines.push("");
  }

  for (const sev of ORDER) {
    const group = issues.filter((i) => i.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${HEADING[sev]} (${group.length})`, "");
    for (const i of group) {
      const loc = i.file ? ` \`${i.file}${i.line ? `:${i.line}` : ""}\`` : "";
      const tag = i.shimmed ? " _(shimmed, handled at runtime)_" : i.autoFixed ? " _(auto-fixed)_" : "";
      lines.push(`- **[${i.category}]**${loc}${tag}: ${i.message}`);
      if (i.fix) lines.push(`  - ${i.autoFixed ? "" : "fix: "}${i.fix}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Write a Markdown summary of the conversion next to the output, so the issue
 * report survives past the terminal scrollback (useful for CI logs / handoff).
 * Returns the path written.
 */
export function writeReportFile(dir: string, meta: ReportMeta, issues: Issue[]): string {
  const p = join(dir, "CONVERSION_REPORT.md");
  writeFileSync(p, buildReportMarkdown(meta, issues), "utf-8");
  return p;
}
