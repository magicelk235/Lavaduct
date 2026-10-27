import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { Manifest } from "../types.js";
import { parseJsonc } from "./manifest.js";

// Firefox's defaults for static rules (toolkit/components/extensions/ExtensionDNRLimits.sys.mjs).
// Each can be raised with an extensions.dnr.* pref, which users don't change.
const MAX_ENABLED_STATIC_RULESETS = 20;
const GUARANTEED_MINIMUM_STATIC_RULES = 30000;
const MAX_REGEX_RULES = 1000;

// Rule conditions Firefox doesn't have. It ignores unknown keys in static rules, so a
// rule using one would match more than it does in Chrome.
const MISSING_CONDITIONS = ["responseHeaders", "excludedResponseHeaders", "topDomains", "excludedTopDomains"];

// Chrome's deprecated spellings of conditions Firefox only knows by their new names.
const RENAMED_CONDITIONS: Array<[string, string]> = [
  ["domains", "initiatorDomains"],
  ["excludedDomains", "excludedInitiatorDomains"],
];

// Request types Chrome has and Firefox never reports. Firefox rejects a rule that lists one.
const MISSING_RESOURCE_TYPES: Record<string, true> = { webbundle: true, webtransport: true };

// rule_resources paths come from the extension's manifest, which is untrusted, and the
// sanitized rules are written back to them, so keep every write inside the staged
// directory. A leading "/" means the extension root, as it does in Firefox.
function resolveInside(stageDir: string, p: string): string | null {
  const root = resolve(stageDir);
  const full = resolve(root, p.replace(/^\/+/, ""));
  const rel = relative(root, full);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return full;
}

type RuleOutcome = { rule: unknown; renamed: boolean; narrowed: boolean } | { reason: string };

// Rewrite one rule into the form Firefox evaluates the way Chrome does, or say why it
// can't be.
function adaptRule(rule: unknown): RuleOutcome {
  if (typeof rule !== "object" || rule === null || !("condition" in rule)) return { rule, renamed: false, narrowed: false };
  const condition = rule.condition;
  if (typeof condition !== "object" || condition === null) return { rule, renamed: false, narrowed: false };

  const missing = MISSING_CONDITIONS.find((k) => k in condition);
  if (missing) return { reason: missing };

  let entries = Object.entries(condition);
  let renamed = false;
  for (const [old, current] of RENAMED_CONDITIONS) {
    if (!(old in condition)) continue;
    // Chrome refuses a rule that spells a condition both ways.
    if (current in condition) return { reason: `${old} with ${current}` };
    entries = entries.map(([k, v]) => [k === old ? current : k, v]);
    renamed = true;
  }

  let narrowed = false;
  const adapted: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if ((k === "resourceTypes" || k === "excludedResourceTypes") && Array.isArray(v) && v.some((t) => MISSING_RESOURCE_TYPES[t] === true)) {
      const left = v.filter((t) => MISSING_RESOURCE_TYPES[t] !== true);
      // Emptied, the list would make the rule match every type, while it only ever
      // targeted requests Firefox doesn't make. An empty exclusion list still means
      // "every type, main_frame included", as the original did.
      if (k === "resourceTypes" && left.length === 0) return { reason: `only ${v.join("/")}` };
      adapted[k] = left;
      narrowed = true;
    } else {
      adapted[k] = v;
    }
  }

  // Chrome compiles regexFilter with RE2 and Firefox with JavaScript's RegExp, which
  // rejects RE2-only syntax such as (?i). Firefox drops such a rule without a word.
  const regex = adapted.regexFilter;
  if (typeof regex === "string") {
    try {
      new RegExp(regex, adapted.isUrlFilterCaseSensitive === true ? "" : "i");
    } catch {
      return { reason: "regexFilter JavaScript can't compile" };
    }
  }
  return { rule: { ...rule, condition: adapted }, renamed, narrowed };
}

/**
 * Rewrite the static DNR rulesets for Firefox and report what changed or won't load.
 * Rules Firefox can't evaluate the way Chrome does are removed, Chrome's deprecated
 * condition names are renamed, and rule files Firefox can't parse are rewritten as
 * strict JSON. The returned notes also name rulesets that Firefox's limits on enabled
 * rulesets, static rules and regex rules would make it ignore.
 */
export function applyDnr(stageDir: string, manifest: Manifest): string[] {
  const notes: string[] = [];
  const loaded: Array<{ id: string; enabled: boolean; rules: unknown[] | null }> = [];
  const resources = manifest.declarative_net_request?.rule_resources;

  for (const res of Array.isArray(resources) ? resources : []) {
    if (!res || typeof res.path !== "string") {
      notes.push("A DNR rule_resources entry has no valid 'path'; Firefox can't load it.");
      continue;
    }
    const id = typeof res.id === "string" ? res.id : res.path;
    const ruleset = { id, enabled: res.enabled === true, rules: null as unknown[] | null };
    loaded.push(ruleset);

    const file = resolveInside(stageDir, res.path);
    if (file === null) {
      notes.push(`DNR ruleset "${id}" path ${res.path} points outside the extension; left untouched.`);
      continue;
    }
    if (!existsSync(file)) {
      notes.push(`DNR ruleset "${id}" points to missing file ${res.path}; Firefox can't load it.`);
      continue;
    }
    // Firefox reads rule files with a strict JSON parser; Chrome tolerates comments and
    // trailing commas.
    const text = readFileSync(file, "utf-8");
    let rules: unknown;
    let strict = true;
    try {
      rules = JSON.parse(text);
    } catch {
      strict = false;
      try {
        rules = parseJsonc(text);
      } catch {
        notes.push(`DNR ruleset "${id}" (${res.path}) is not valid JSON; Firefox can't load it.`);
        continue;
      }
    }
    if (!Array.isArray(rules)) {
      notes.push(`DNR ruleset "${id}" (${res.path}) is not a JSON array of rules; Firefox can't load it.`);
      continue;
    }

    const kept: unknown[] = [];
    const removed: string[] = [];
    let renamed = 0;
    let narrowed = 0;
    for (const rule of rules) {
      const outcome = adaptRule(rule);
      if ("reason" in outcome) {
        const ruleId = typeof rule === "object" && rule !== null && "id" in rule ? String(rule.id) : "without an id";
        removed.push(`rule ${ruleId} (${outcome.reason})`);
        continue;
      }
      kept.push(outcome.rule);
      if (outcome.renamed) renamed++;
      if (outcome.narrowed) narrowed++;
    }
    ruleset.rules = kept;

    if (!strict || removed.length || renamed || narrowed) {
      writeFileSync(file, JSON.stringify(kept, null, 2) + "\n", "utf-8");
    }
    if (removed.length) {
      const shown = removed.slice(0, 10).join(", ") + (removed.length > 10 ? `, and ${removed.length - 10} more` : "");
      notes.push(`DNR ruleset "${id}" (${res.path}): removed ${removed.length} rule(s) Firefox can't evaluate the way Chrome does: ${shown}.`);
    }
    if (renamed) {
      notes.push(`DNR ruleset "${id}": renamed domains/excludedDomains to initiatorDomains/excludedInitiatorDomains in ${renamed} rule(s); Firefox only knows the new names.`);
    }
    if (narrowed) {
      notes.push(`DNR ruleset "${id}": removed the webbundle/webtransport resource types from ${narrowed} rule(s); Firefox never makes those requests.`);
    }
  }

  // Replay Firefox's start-up: enabled rulesets load in manifest order, the cap on
  // enabled rulesets applies before a file is read, and a ruleset that would overflow
  // a quota is skipped whole while later ones still get their turn.
  let enabled = 0;
  let rulesLeft = GUARANTEED_MINIMUM_STATIC_RULES;
  let regexLeft = MAX_REGEX_RULES;
  const overflow: string[] = [];
  for (const { id, enabled: isEnabled, rules } of loaded) {
    if (!isEnabled) continue;
    if (enabled >= MAX_ENABLED_STATIC_RULESETS) {
      overflow.push(`"${id}"`);
      continue;
    }
    if (rules === null) continue;
    const regexRules = rules.filter(
      (r) =>
        typeof r === "object" && r !== null && "condition" in r &&
        typeof r.condition === "object" && r.condition !== null &&
        "regexFilter" in r.condition && !!r.condition.regexFilter,
    ).length;
    if (rules.length > rulesLeft) {
      notes.push(`DNR ruleset "${id}" would take the enabled static rules past Firefox's limit of ${GUARANTEED_MINIMUM_STATIC_RULES} (it has ${rules.length} rules and ${rulesLeft} are left), so Firefox ignores the whole ruleset.`);
      continue;
    }
    if (regexRules > regexLeft) {
      notes.push(`DNR ruleset "${id}" has ${regexRules} regexFilter rules, past Firefox's limit of ${MAX_REGEX_RULES} (${regexLeft} are left), so Firefox ignores the whole ruleset.`);
      continue;
    }
    rulesLeft -= rules.length;
    regexLeft -= regexRules;
    enabled++;
  }
  if (overflow.length) {
    notes.push(`Firefox enables at most ${MAX_ENABLED_STATIC_RULESETS} static DNR rulesets and ignores the rest: ${overflow.join(", ")}.`);
  }
  return notes;
}
