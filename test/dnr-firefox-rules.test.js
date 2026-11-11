import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { applyDnr as applyDnrIssues } from "../dist/manifest/dnr.js";

// The notes are issues for the report; these tests read their messages.
function applyDnr(dir, manifest) {
  const result = applyDnrIssues(dir, manifest);
  for (const note of result.notes) assert.equal(note.category, "dnr");
  return { ...result, notes: result.notes.map((n) => n.message) };
}

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "lavaduct-dnr-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

const block = (id, condition = {}) => ({ id, priority: 1, action: { type: "block" }, condition: { urlFilter: "ads", ...condition } });
const manifestWith = (...resources) => ({
  manifest_version: 3,
  declarative_net_request: { rule_resources: resources.map(([id, path, enabled = true]) => ({ id, enabled, path })) },
});
const readRules = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), "utf-8"));

test("a rule conditioned on response headers is removed and named", () => {
  const dir = stage({
    "rules.json": [block(1), block(2, { responseHeaders: [{ header: "content-type", values: ["text/html"] }] }), block(3)],
  });
  try {
    const { notes } = applyDnr(dir, manifestWith(["main", "rules.json"]));
    assert.deepEqual(readRules(dir, "rules.json").map((r) => r.id), [1, 3]);
    const note = notes.find((n) => n.includes('"main"'));
    assert.ok(note, "a note names the ruleset");
    assert.match(note, /rule 2 \(responseHeaders\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resource types Firefox never sees are taken out of rules, and a rule left with none is removed", () => {
  const dir = stage({
    "rules.json": [
      block(1, { resourceTypes: ["script", "webbundle"] }),
      block(2, { excludedResourceTypes: ["webtransport"] }),
      block(3, { resourceTypes: ["webbundle"] }),
      block(4),
    ],
  });
  try {
    const { notes } = applyDnr(dir, manifestWith(["main", "rules.json"]));
    assert.deepEqual(readRules(dir, "rules.json"), [
      block(1, { resourceTypes: ["script"] }),
      // Still every type, main_frame included, like the Chrome rule.
      block(2, { excludedResourceTypes: [] }),
      block(4),
    ]);
    assert.ok(notes.some((n) => /rule 3 \(only webbundle\)/.test(n)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a regexFilter only RE2 understands is removed instead of silently skipped", () => {
  const rules = [
    { id: 1, priority: 1, action: { type: "block" }, condition: { regexFilter: "(?i)^https://ads\\." } },
    { id: 2, priority: 1, action: { type: "block" }, condition: { regexFilter: "^https://ads\\." } },
  ];
  const dir = stage({ "rules.json": rules });
  try {
    const { notes } = applyDnr(dir, manifestWith(["main", "rules.json"]));
    assert.deepEqual(readRules(dir, "rules.json"), [rules[1]]);
    assert.ok(notes.some((n) => /rule 1 \(regexFilter/.test(n)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the deprecated domains conditions are renamed so the rule keeps its scope", () => {
  const dir = stage({
    "rules.json": [
      block(1, { domains: ["news.example"], excludedDomains: ["shop.news.example"] }),
      block(2, { domains: ["a.example"], initiatorDomains: ["b.example"] }),
    ],
  });
  try {
    const { notes } = applyDnr(dir, manifestWith(["main", "rules.json"]));
    const rules = readRules(dir, "rules.json");
    // Left alone, Firefox would ignore the unknown keys and block "ads" on every site.
    assert.deepEqual(rules, [block(1, { initiatorDomains: ["news.example"], excludedInitiatorDomains: ["shop.news.example"] })]);
    assert.ok(notes.some((n) => /initiatorDomains/.test(n)));
    assert.ok(notes.some((n) => /rule 2/.test(n)), "a rule with both spellings is dropped and named");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rules file with comments is rewritten as JSON Firefox can read", () => {
  const dir = stage({ "rules.json": '// blocklist\n[\n  {"id": 1, "priority": 1, "action": {"type": "block"}, "condition": {"urlFilter": "ads"}},\n]\n' });
  try {
    applyDnr(dir, manifestWith(["main", "rules.json"]));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "rules.json"), "utf-8")), [block(1)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enabled rulesets past Firefox's twenty are named", () => {
  const files = {};
  const resources = [];
  for (let i = 1; i <= 22; i++) {
    files[`r${i}.json`] = [block(1)];
    resources.push([`set${i}`, `r${i}.json`]);
  }
  resources.push(["off", "r1.json", false]);
  const dir = stage(files);
  try {
    const { notes } = applyDnr(dir, manifestWith(...resources));
    const note = notes.find((n) => n.includes("20"));
    assert.ok(note);
    assert.match(note, /"set21", "set22"/);
    assert.doesNotMatch(note, /"set20"|"off"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ruleset that would overflow the static rule quota is named; later ones still count", () => {
  const rules = (n, start = 1) => Array.from({ length: n }, (_, i) => block(start + i));
  const dir = stage({ "a.json": rules(20000), "b.json": rules(15000), "c.json": rules(5000) });
  try {
    const { notes, staticRules } = applyDnr(dir, manifestWith(["a", "a.json"], ["b", "b.json"], ["c", "c.json"]));
    assert.equal(staticRules, 40000, "every ruleset counts, enabled or not, since the add-on can enable them later");
    const quota = notes.filter((n) => n.includes("30000"));
    assert.equal(quota.length, 1);
    assert.match(quota[0], /"b"/);
    assert.doesNotMatch(quota[0], /"c"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ruleset that would overflow the regex quota is named", () => {
  const regexRules = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, priority: 1, action: { type: "block" }, condition: { regexFilter: `^https://ads${i}\\.` } }));
  const dir = stage({ "re.json": regexRules });
  try {
    const { notes } = applyDnr(dir, manifestWith(["regex", "re.json"]));
    assert.ok(notes.some((n) => n.includes('"regex"') && n.includes("1000")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ruleset path outside the extension is never written", () => {
  const outer = mkdtempSync(join(tmpdir(), "lavaduct-dnr-outer-"));
  const dir = join(outer, "ext");
  mkdirSync(dir);
  const victim = join(outer, "victim.json");
  const original = JSON.stringify([block(1, { responseHeaders: [{ header: "x" }] })]);
  writeFileSync(victim, original);
  try {
    const { notes } = applyDnr(dir, manifestWith(["evil", "../victim.json"]));
    assert.equal(readFileSync(victim, "utf-8"), original);
    assert.ok(notes.some((n) => n.includes("evil")));
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("a leading slash in the ruleset path means the extension root", () => {
  const dir = stage({ "rules/a.json": [block(1, { responseHeaders: [{ header: "x" }] }), block(2)] });
  try {
    applyDnr(dir, manifestWith(["main", "/rules/a.json"]));
    assert.deepEqual(readRules(dir, "rules/a.json").map((r) => r.id), [2]);
    assert.equal(existsSync("/rules/a.json"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a redirect to a data: URL points at a web-accessible file with the same bytes", () => {
  const redirect = (id, url) => ({ id, priority: 1, action: { type: "redirect", redirect: { url } }, condition: { urlFilter: "ads" } });
  const script = "data:application/javascript,window.ads%3D1";
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const dir = stage({
    "a.json": [redirect(1, script), redirect(2, png), block(3)],
    "b.json": [redirect(1, script), redirect(2, "https://example.com/x.js")],
  });
  try {
    const manifest = { ...manifestWith(["a", "a.json"], ["b", "b.json"]), web_accessible_resources: [{ resources: ["x.css"], matches: ["<all_urls>"] }] };
    const { notes } = applyDnr(dir, manifest);
    const a = readRules(dir, "a.json");
    const b = readRules(dir, "b.json");
    const scriptPath = a[0].action.redirect.extensionPath;
    assert.match(scriptPath, /^\/lavaduct-dnr-redirects\/[0-9a-f]{16}\.js$/, "a script stand-in keeps a .js name, so Firefox serves it as JavaScript");
    assert.equal(readFileSync(join(dir, scriptPath), "utf-8"), "window.ads=1");
    assert.match(a[1].action.redirect.extensionPath, /\.png$/);
    assert.deepEqual(readFileSync(join(dir, a[1].action.redirect.extensionPath)), Buffer.from("iVBORw0KGgo=", "base64"));
    assert.deepEqual(a[2], block(3));
    assert.equal(b[0].action.redirect.extensionPath, scriptPath, "the same URL in another ruleset shares the file");
    assert.deepEqual(b[1].action.redirect, { url: "https://example.com/x.js" });
    assert.deepEqual(manifest.web_accessible_resources, [
      { resources: ["x.css"], matches: ["<all_urls>"] },
      { resources: ["lavaduct-dnr-redirects/*"], matches: ["<all_urls>"] },
    ]);
    assert.ok(notes.some((n) => /^3 DNR rule\(s\) in 2 ruleset\(s\) redirect to data: URLs/.test(n)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an IPv6 address in a static rule's domains gets the brackets Firefox wants", () => {
  const dir = stage({ "rules.json": [block(1, { requestDomains: ["::1", "example.com"], excludedInitiatorDomains: ["[::2]"] })] });
  try {
    applyDnr(dir, manifestWith(["main", "rules.json"]));
    assert.deepEqual(readRules(dir, "rules.json")[0].condition, { urlFilter: "ads", requestDomains: ["[::1]", "example.com"], excludedInitiatorDomains: ["[::2]"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
