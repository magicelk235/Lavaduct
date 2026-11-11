#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AmoCredentials, Platforms, SignRoute } from "./types.js";
import { CONFIG_FILE, DEDICATED_PROFILE, ENV_PREFIX, NAME } from "./name.js";
import { PACKAGE_ROOT } from "./paths.js";
import { cacheDir, stateDir } from "./state.js";
import { AMO_CREDENTIALS_MISSING, analyzeExtension, convert, findFirefox, noFirefoxMessage, type AnalyzeOptions } from "./convert.js";
import { DEFAULT_MIN_FIREFOX } from "./manifest/manifest.js";
import { buildReportMarkdown, countBlocking, printIssues } from "./analyze/report.js";
import { downloadExtension, isUrl } from "./input/download.js";
import { isAmoAddonId } from "./sign/addon-id.js";
import { checkAmoCredentials, removeSignedCache } from "./sign/amo.js";
import { resolveAmoCredentials } from "./sign/credentials.js";
import { findFirefoxInstalls, selectFirefox, type FirefoxInstall } from "./firefox/locate.js";
import { listProfiles, profileInUse, profilesFor, resolveProfile, type FirefoxProfile } from "./firefox/profiles.js";
import { readInstalledAddons } from "./firefox/extensions-json.js";
import { recordedInstalls, removeInstallRecord } from "./firefox/install.js";
import { unregisterNativeHosts } from "./firefox/native-hosts.js";
import { openProfileInFirefox, quitFirefoxForProfile } from "./firefox/launch.js";
import { BidiSession } from "./firefox/bidi.js";
import { formatDebugLog, readDebugLog } from "./firefox/storage.js";
import { pathKey } from "./firefox/platform/shared.js";
import { color, fail, info, ok, setQuiet, setVerbose, warn } from "./util.js";

// Option keys a config file may set, named like the long flags so the file reads
// like a command line: { "sign": "amo", "firefox": "nightly" }, with the type each
// value must have. A boolean must be a real one: the string "false" is truthy and
// would turn the flag on. One-shot and meta flags (analyze, doctor, list, version,
// …) aren't worth persisting.
const CONFIG_KEYS: Record<string, "string" | "boolean"> = {
  output: "string",
  "addon-id": "string",
  "addon-version": "string",
  "min-firefox": "string",
  platforms: "string",
  "data-collection": "string",
  zip: "boolean",
  clean: "boolean",
  sign: "string",
  "amo-key": "string",
  "amo-secret": "string",
  install: "boolean",
  firefox: "string",
  profile: "string",
  verify: "boolean",
  "no-firefox-restart": "boolean",
  "no-launch": "boolean",
  "native-hosts": "boolean",
  "no-native-hosts": "boolean",
  "no-shim": "boolean",
  "no-oauth-bridge": "boolean",
  "panel-query": "string",
  debug: "boolean",
  force: "boolean",
  strict: "boolean",
};

// Config keys that also have a short flag, which is what argv carries when the
// user typed the short form.
const CONFIG_SHORT_ALIAS: Record<string, string> = { output: "o" };

// Config keys that give way to another typed flag: their opposite switch, or a
// flag they can't be combined with. Otherwise the config would contradict the
// flag the user typed and fail the run.
const CONFIG_OVERRIDDEN_BY: Record<string, string> = {
  "native-hosts": "no-native-hosts",
  "no-native-hosts": "native-hosts",
  debug: "no-shim",
  "no-shim": "debug",
};

interface LoadedConfig {
  path: string | null;
  applied: Set<string>;
  /** Kept apart from the flags: config credentials rank below the environment. */
  credentials: Partial<AmoCredentials>;
}

// Load a JSON config and fill in every flag the command line didn't give; a flag
// the user typed always wins, which parseArgs can't tell, so argv is checked.
function applyConfig(values: Record<string, unknown>, explicitPath: string | undefined, argv: string[]): LoadedConfig {
  const applied = new Set<string>();
  const credentials: Partial<AmoCredentials> = {};
  const path = explicitPath ?? (existsSync(CONFIG_FILE) ? CONFIG_FILE : undefined);
  if (!path) return { path: null, applied, credentials };
  if (!existsSync(path)) {
    fail(`Config file not found: ${path}`);
    process.exit(2);
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(resolve(path), "utf-8"));
  } catch (e) {
    fail(`Could not parse ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    fail(`${path} must hold a JSON object keyed by long flag name, e.g. { "sign": "amo" }.`);
    process.exit(2);
  }
  for (const [key, val] of Object.entries(cfg as Record<string, unknown>)) {
    const type = Object.hasOwn(CONFIG_KEYS, key) ? CONFIG_KEYS[key] : undefined;
    if (!type) {
      warn(`Ignoring unknown config key "${key}" in ${path}.`);
      continue;
    }
    if (typeof val !== type) {
      warn(`Ignoring config "${key}": expected ${type === "boolean" ? "true/false" : "a string"}, got ${JSON.stringify(val)}.`);
      continue;
    }
    if (key === "amo-key" || key === "amo-secret") {
      if (typeof val === "string") credentials[key === "amo-key" ? "key" : "secret"] = val;
      continue;
    }
    // The short alias appears bare (-o dir), attached (-odir) or grouped behind
    // boolean shorts (-qo dir); parseArgs accepts all of them.
    const typed = (flag: string) => {
      const short = CONFIG_SHORT_ALIAS[flag];
      return (
        argv.includes(`--${flag}`) ||
        argv.some((a) => a.startsWith(`--${flag}=`)) ||
        (short !== undefined && argv.some((a) => new RegExp(`^-(?!-)[A-Za-z]*${short}`).test(a)))
      );
    };
    const opposite = Object.hasOwn(CONFIG_OVERRIDDEN_BY, key) ? CONFIG_OVERRIDDEN_BY[key] : undefined;
    if (typed(key) || (opposite !== undefined && typed(opposite))) continue;
    values[key] = val;
    applied.add(key);
  }
  return { path, applied, credentials };
}

function pkgVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));
    return pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// strict_min_version takes a Firefox version: 1 to 4 numbers.
const MIN_FIREFOX_RE = /^\d+(\.\d+){0,3}$/;

// Firefox and AMO take 1 to 4 integers of at most 9 digits, without leading zeros.
const ADDON_VERSION_RE = /^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){0,3}$/;

// Values of gecko.data_collection_permissions.required (DataCollectionPermission in
// Firefox's manifest schema).
const DATA_COLLECTION = [
  "none", "authenticationInfo", "bookmarksInfo", "browsingActivity", "financialAndPaymentInfo", "healthInfo",
  "locationInfo", "personalCommunications", "personallyIdentifyingInfo", "searchTerms", "websiteActivity",
  "websiteContent",
];

const SIGN_ROUTES = ["auto", "amo", "unsigned", "temporary"];

const HELP = `${NAME}: convert a Chrome extension into a Firefox add-on

USAGE
  ${NAME} <input> [options]
  ${NAME} <in1> <in2> …              # batch: convert several inputs in one run
  ${NAME} <input> --analyze          # report only, no conversion
  ${NAME} <input> --install          # convert, then install into Firefox
  ${NAME} --doctor                   # check Firefox, profiles, Node and AMO credentials
  ${NAME} --list                     # list the add-ons in Firefox profiles
  ${NAME} --uninstall <name|id>      # remove an add-on and its data from a profile
  ${NAME} --logs <name|id>           # print a --debug build's persisted debug log

INPUT
  A .zip, .crx, .xpi, an unpacked extension directory, or a URL (type detected by magic bytes).
  URLs may be a Chrome Web Store link (https://chromewebstore.google.com/detail/<name>/<id>)
  or a direct .crx / .zip download link; the source is fetched automatically.

OUTPUT
  -o, --output <dir>          Output directory (default: ./<Name>_Firefox). It holds the
                              .xpi, the staged extension and CONVERSION_REPORT.md.
      --addon-id <id>         Add-on ID, e.g. name@example.com. The default is derived from
                              the extension and a salt kept on this machine, so it stays the
                              same for you and never collides with anyone else's on AMO.
      --addon-version <ver>   Version to write instead of the extension's (1 to 4 numbers)
      --min-firefox <ver>     strict_min_version (default: ${DEFAULT_MIN_FIREFOX}, the current ESR)
      --platforms <p>         desktop | android | all (default: desktop)
      --data-collection <l>   Comma-separated gecko data_collection_permissions.required,
                              e.g. "none". AMO wants it for new add-ons; it is only written
                              when given, since ${NAME} can't know what an extension collects.
      --zip                   Also write the unsigned add-on as a .zip
      --clean                 Wipe the output directory before staging

SIGNING AND INSTALLING
      --sign <route>          auto | amo | unsigned | temporary (default: auto). auto picks
                              amo when AMO credentials are set, else unsigned when the target
                              Firefox can run unsigned add-ons (Nightly, Developer Edition,
                              ESR), else temporary.
      --amo-key <key>         AMO API key (or ${ENV_PREFIX}_AMO_KEY, or WEB_EXT_API_KEY)
      --amo-secret <secret>   AMO API secret (or ${ENV_PREFIX}_AMO_SECRET, or WEB_EXT_API_SECRET)
      --install               Install into Firefox once the .xpi is packed (and signed)
      --firefox <which>       Firefox to use: release, beta, nightly, esr, developer-edition,
                              or a path (default: release if installed, else the first found)
      --profile <name|path>   Profile to install into (default: the Firefox's default profile;
                              the temporary route uses its own "${DEDICATED_PROFILE}" profile)
      --verify                After --install, wait up to 120 s for the add-on to be installed
                              and enabled (time to accept Firefox's install prompt)
      --no-firefox-restart    Never quit and restart Firefox; say what is left to do instead
      --no-launch             Don't start Firefox: stop once the .xpi is written (and signed)
      --headless              Load the add-on temporarily into a Firefox without a window, then
                              quit it again: a load check for CI. Implies --sign temporary.
      --native-hosts          Register the add-on with the native apps it talks to: for each one
                              whose Chrome host manifest allows the extension, write or extend its
                              Firefox host manifest. On by default with --install.
      --no-native-hosts       Don't touch native host manifests, even with --install

COMPATIBILITY
      --no-shim               Do not write or inject the compatibility shim
      --no-oauth-bridge       Do not bridge externally_connectable pages to the add-on
      --panel-query <q>       Query added to the sidebar page made from side_panel. By default
                              ${NAME} uses the query the extension itself opens that page with as
                              a standalone window (mode=window), if it has one. Pass "" for none.
      --debug                 Build the shim with tracing on. Traces persist to a bounded ring
                              buffer (last 2000 entries) in storage.local under
                              __viaduct_debug_log__; read it back with --logs. Dev builds only.

ANALYSIS
      --force                 Convert despite blocking errors
      --strict                Treat warnings as blocking too (CI gate). With --analyze,
                              exit 1 if any warning or error is present.
      --analyze               Analyze and report only (also previews the manifest changes)
      --json                  With --analyze, print a machine-readable JSON report
      --report <file>         With --analyze, also write the report to <file> (.json if --json,
                              else Markdown)
      --config <file>         Load defaults from <file> (default: ./${CONFIG_FILE} if present).
                              JSON keyed by long flag name; command-line flags override it.

FIREFOX
      --doctor                List Firefox installs, profiles, the Node version, whether AMO
                              credentials work, and where ${NAME} keeps its files
      --list                  List the add-ons in --profile, or in every profile of the
                              selected Firefox; marks the ones ${NAME} installed
      --uninstall <name|id>   Remove an add-on and its data from --profile (default: the
                              Firefox's default profile), quitting and reopening Firefox if
                              it has the profile open
      --logs <name|id>        Print the persisted debug log of a --debug build in --profile

  -q, --quiet                 Suppress progress messages (warnings and errors still print)
  -v, --verbose               Verbose output
  -h, --help                  Show this help
      --version               Print the version and exit
`;

function writeAnalyzeReport(path: string, content: string): void {
  try {
    writeFileSync(resolve(path), content, "utf-8");
    ok(`Report written → ${path}`);
  } catch (e) {
    warn(`Could not write report to ${path}: ${(e as Error).message}`);
  }
}

function analyzeOnly(input: string, settings: Omit<AnalyzeOptions, "input">, json: boolean, strict: boolean, reportPath?: string): number {
  let a;
  try {
    a = analyzeExtension({ ...settings, input });
  } catch (e) {
    const msg = (e as Error).message;
    // JSON mode always prints parseable output, so a consumer never gets a bare
    // error on a corrupt archive or a missing manifest.
    if (json) console.log(JSON.stringify({ error: msg, convertible: false }, null, 2));
    else fail(msg);
    return 1;
  }
  if (!json) info(`${a.name} (MV${a.manifestVersion})`);
  // The same gate as a conversion: auto-fixed issues don't block.
  const blocking = countBlocking(a.issues, strict);
  if (json) {
    const counts = { error: 0, warning: 0, info: 0 };
    let autoFixed = 0;
    let shimmed = 0;
    for (const i of a.issues) {
      counts[i.severity]++;
      if (i.shimmed) shimmed++;
      else if (i.autoFixed) autoFixed++;
    }
    const out = JSON.stringify(
      {
        name: a.name,
        appName: a.appName,
        addonId: a.addonId,
        version: a.version,
        manifestVersion: a.manifestVersion,
        platforms: settings.platforms,
        counts,
        autoFixed,
        shimmed,
        blocking,
        convertible: blocking === 0,
        removedPermissions: a.removedPermissions,
        manifestChanges: a.manifestChanges,
        issues: a.issues,
      },
      null,
      2,
    );
    console.log(out);
    if (reportPath) writeAnalyzeReport(reportPath, out);
  } else {
    printIssues(a.issues, strict);
    if (a.manifestChanges.length > 0) {
      console.log(`\n${color("blue", `Manifest changes the converter would apply (${a.manifestChanges.length})`)}`);
      for (const c of a.manifestChanges) console.log(`  • ${c}`);
    }
    if (reportPath) {
      const meta = {
        name: a.name,
        version: a.version,
        manifestVersion: a.manifestVersion,
        platforms: settings.platforms,
        removedPermissions: a.removedPermissions,
        manifestChanges: a.manifestChanges,
        strict,
      };
      writeAnalyzeReport(reportPath, buildReportMarkdown(meta, a.issues));
    }
  }
  return blocking > 0 ? 1 : 0;
}

/** The profile --profile names; without a Firefox install only a directory works. */
function pickProfile(selector: string | undefined, install: FirefoxInstall | undefined): FirefoxProfile {
  if (install) return resolveProfile(selector, install);
  if (selector !== undefined && statSync(selector, { throwIfNoEntry: false })?.isDirectory()) {
    return { path: resolve(selector), isDefault: false };
  }
  throw new Error(noFirefoxMessage());
}

/** An add-on in a profile, by ID or by name, from extensions.json or this tool's install records. */
function findAddon(query: string, profilePath: string): { id: string; name: string; installed: boolean } | undefined {
  const key = pathKey(profilePath);
  const installed = readInstalledAddons(profilePath);
  const known = [
    ...installed.map((a) => ({ id: a.id, name: a.name, installed: true })),
    ...recordedInstalls()
      .filter((r) => pathKey(r.profilePath) === key && !installed.some((a) => a.id === r.id))
      .map((r) => ({ id: r.id, name: r.name, installed: false })),
  ];
  const byId = known.find((a) => a.id === query);
  if (byId) return byId;
  const named = known.filter((a) => a.name.toLowerCase() === query.toLowerCase());
  if (named.length > 1) {
    throw new Error(
      `More than one add-on in ${profilePath} is named "${query}" (${named.map((a) => a.id).join(", ")}). Pass its ID instead.`,
    );
  }
  return named[0];
}

async function doctor(credentials: { flag: Partial<AmoCredentials>; config: Partial<AmoCredentials> }, configPath: string | null, firefoxSelector?: string): Promise<number> {
  let healthy = true;
  const heading = (title: string) => console.error(`\n${color("bold", title)}`);
  info(`${NAME} ${pkgVersion()}`);

  heading("Firefox");
  const installs = findFirefoxInstalls();
  const chosen = selectFirefox(installs, firefoxSelector);
  if (installs.length === 0) {
    fail(noFirefoxMessage());
    healthy = false;
  } else if (firefoxSelector && !chosen) {
    fail(noFirefoxMessage(firefoxSelector));
    healthy = false;
  }
  for (const install of chosen && !installs.includes(chosen) ? [...installs, chosen] : installs) {
    const used = install === chosen ? (firefoxSelector ? " (selected)" : " (used by default)") : "";
    ok(`Firefox ${install.version}, ${install.channel} channel${used}: ${install.installDir}`);
    console.error(
      install.requireSigning
        ? "    Installs signed add-ons only: the amo and temporary routes work, the unsigned route doesn't."
        : "    Can run unsigned add-ons: every route works.",
    );
    try {
      const def = resolveProfile(undefined, install);
      console.error(`    Default profile: ${def.name ?? def.path}`);
    } catch (e) {
      warn(`    ${(e as Error).message}`);
    }
  }

  heading("Profiles");
  const profiles = listProfiles();
  if (profiles.length === 0) warn("No Firefox profiles found. Start Firefox once so it creates one, or pass --profile <path>.");
  for (const p of profiles) {
    const tags = [p.isDefault ? "default" : "", profileInUse(p.path) ? "in use" : ""].filter(Boolean);
    info(`${p.name ?? basename(p.path)}${tags.length ? ` (${tags.join(", ")})` : ""}: ${p.path}`);
  }

  heading("Node");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) ok(`Node ${process.versions.node}`);
  else {
    fail(`Node ${process.versions.node} is too old: ${NAME} needs Node 22.13 or newer.`);
    healthy = false;
  }

  heading("AMO");
  let creds: AmoCredentials | undefined;
  try {
    creds = resolveAmoCredentials(credentials.flag, credentials.config);
  } catch (e) {
    fail((e as Error).message);
    healthy = false;
  }
  if (creds) {
    const check = await checkAmoCredentials(creds);
    if (check.ok) ok(`AMO credentials work: ${check.detail}`);
    else {
      fail(`AMO credentials don't work: ${check.detail}`);
      healthy = false;
    }
  } else if (healthy) {
    info(
      `No AMO credentials, so the amo route is off. Set ${ENV_PREFIX}_AMO_KEY and ${ENV_PREFIX}_AMO_SECRET ` +
        "(or WEB_EXT_API_KEY and WEB_EXT_API_SECRET) to sign through AMO.",
    );
  }

  heading("Files");
  info(`Config: ${configPath ? resolve(configPath) : `${resolve(CONFIG_FILE)} (not present)`}`);
  info(`State: ${stateDir()}`);
  info(`Signed add-on cache: ${cacheDir()}`);
  return healthy ? 0 : 1;
}

function listAddons(profileSelector: string | undefined, firefoxSelector: string | undefined): number {
  const install = selectFirefox(findFirefoxInstalls(), firefoxSelector);
  if (firefoxSelector && !install) throw new Error(noFirefoxMessage(firefoxSelector));
  const profiles =
    profileSelector !== undefined ? [pickProfile(profileSelector, install)] : install ? profilesFor(install) : listProfiles();
  if (profiles.length === 0) {
    warn("No Firefox profiles found. Start Firefox once so it creates one, or pass --profile <path>.");
    return 0;
  }
  const ours = new Set(recordedInstalls().map((r) => `${r.id}\n${pathKey(r.profilePath)}`));
  let unreadable = false;
  for (const p of profiles) {
    const tags = [p.isDefault ? "default" : "", profileInUse(p.path) ? "in use" : ""].filter(Boolean);
    console.log(`${p.name ?? basename(p.path)}${tags.length ? ` (${tags.join(", ")})` : ""}: ${p.path}`);
    let addons;
    try {
      addons = readInstalledAddons(p.path);
    } catch (e) {
      fail((e as Error).message);
      unreadable = true;
      continue;
    }
    if (addons.length === 0) console.log("  (no add-ons)");
    for (const a of addons) {
      const state = a.active ? "enabled" : a.userDisabled ? "disabled" : "inactive";
      const mark = ours.has(`${a.id}\n${pathKey(p.path)}`) ? `  (installed by ${NAME})` : "";
      console.log(`  ${a.name} ${a.version}  ${a.id}  ${state}${mark}`);
    }
  }
  return unreadable ? 1 : 0;
}

async function uninstallAddon(query: string, profileSelector: string | undefined, firefoxSelector: string | undefined, restart: boolean): Promise<number> {
  const install = findFirefox(firefoxSelector);
  const profile = resolveProfile(profileSelector, install);
  const addon = findAddon(query, profile.path);
  if (!addon) {
    fail(`No add-on named "${query}" or with that ID in ${profile.path}. Run --list to see the add-ons there.`);
    return 1;
  }
  if (addon.installed) {
    const wasOpen = profileInUse(profile.path);
    if (wasOpen) {
      if (!restart) {
        fail(`Firefox has ${profile.path} open. Quit it first, or drop --no-firefox-restart so ${NAME} quits and reopens it.`);
        return 1;
      }
      info(`Quitting the Firefox that has ${profile.path} open …`);
      if (!(await quitFirefoxForProfile(install, profile.path))) {
        fail(`Couldn't quit the Firefox that has ${profile.path} open. Quit it yourself, then try again.`);
        return 1;
      }
    }
    try {
      info(`Removing ${addon.name} (${addon.id}) from ${profile.path} …`);
      // A Firefox without a window, started just for this: the remote agent only
      // starts with a new process. The devtools server the temporary route uses
      // can only remove temporary add-ons.
      const session = await BidiSession.start(install, profile.path);
      try {
        await session.uninstallExtension(addon.id);
      } finally {
        await session.closeBrowser();
      }
    } finally {
      if (wasOpen) {
        openProfileInFirefox(install, profile);
        info("Started Firefox again");
      }
    }
  } else {
    info(`${addon.name} (${addon.id}) isn't installed in ${profile.path} any more; forgetting it.`);
  }
  removeSignedCache(addon.id);
  removeInstallRecord(addon.id, profile.path);
  // Host manifests are per user, not per profile: they keep the add-on while
  // another profile has it installed.
  if (!recordedInstalls().some((r) => r.id === addon.id)) {
    for (const note of unregisterNativeHosts(addon.id)) (note.ok ? ok : warn)(`Native messaging: ${note.detail}`);
  }
  ok(`Uninstalled ${addon.name} (${addon.id}) from ${profile.path}`);
  return 0;
}

function printLogs(query: string, profileSelector: string | undefined, firefoxSelector: string | undefined): number {
  const install = selectFirefox(findFirefoxInstalls(), firefoxSelector);
  if (firefoxSelector && !install) throw new Error(noFirefoxMessage(firefoxSelector));
  const profile = pickProfile(profileSelector, install);
  // A temporary install never shows up in extensions.json, but its storage stays,
  // so an ID is taken as it is.
  const id = findAddon(query, profile.path)?.id ?? (/@|^\{[0-9a-f-]+\}$/i.test(query) ? query : undefined);
  if (!id) throw new Error(`No add-on named "${query}" in ${profile.path}. Pass its ID, or run --list to see the add-ons there.`);
  const { entries, source } = readDebugLog(profile.path, id);
  info(`${entries.length} entries from ${source}`);
  if (entries.length > 0) console.log(formatDebugLog(entries));
  return 0;
}

function parseDataCollection(raw: string): string[] {
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = list.filter((v) => !DATA_COLLECTION.includes(v));
  if (list.length === 0 || unknown.length > 0) {
    fail(
      `Invalid --data-collection "${raw}". Use none, or a comma-separated list of: ${DATA_COLLECTION.slice(1).join(", ")}.` +
        (unknown.includes("technicalAndInteraction") ? " technicalAndInteraction can only be optional, so it isn't accepted here." : ""),
    );
    process.exit(2);
  }
  if (list.includes("none") && list.length > 1) {
    fail('--data-collection "none" can\'t be combined with other values.');
    process.exit(2);
  }
  return list;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        "addon-id": { type: "string" },
        "addon-version": { type: "string" },
        "min-firefox": { type: "string" },
        platforms: { type: "string", default: "desktop" },
        "data-collection": { type: "string" },
        zip: { type: "boolean", default: false },
        clean: { type: "boolean", default: false },
        sign: { type: "string", default: "auto" },
        "amo-key": { type: "string" },
        "amo-secret": { type: "string" },
        install: { type: "boolean", default: false },
        firefox: { type: "string" },
        profile: { type: "string" },
        verify: { type: "boolean", default: false },
        "no-firefox-restart": { type: "boolean", default: false },
        "no-launch": { type: "boolean", default: false },
        headless: { type: "boolean", default: false },
        "native-hosts": { type: "boolean", default: false },
        "no-native-hosts": { type: "boolean", default: false },
        "no-shim": { type: "boolean", default: false },
        "no-oauth-bridge": { type: "boolean", default: false },
        "panel-query": { type: "string" },
        debug: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        analyze: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        report: { type: "string" },
        config: { type: "string" },
        doctor: { type: "boolean", default: false },
        list: { type: "boolean", default: false },
        uninstall: { type: "string" },
        logs: { type: "string" },
        quiet: { type: "boolean", short: "q", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (e) {
    fail((e as Error).message);
    console.log(HELP);
    process.exit(2);
  }

  const { values, positionals } = parsed;
  setVerbose(values.verbose);
  setQuiet(values.quiet && !values.verbose);

  // Overlay the config before validating, so config values are checked like flags.
  const config = applyConfig(values as Record<string, unknown>, values.config, process.argv.slice(2));
  if (config.path) info(`Using config ${config.path}`);
  const flagCredentials = { key: values["amo-key"], secret: values["amo-secret"] };

  if (values.version) {
    console.log(pkgVersion());
    process.exit(0);
  }
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    if (values.doctor) {
      process.exitCode = await doctor({ flag: flagCredentials, config: config.credentials }, config.path, values.firefox);
      return;
    }
    if (values.list) {
      process.exitCode = listAddons(values.profile, values.firefox);
      return;
    }
    if (values.uninstall !== undefined) {
      const query = values.uninstall.trim();
      if (!query) {
        fail('--uninstall needs an add-on name or ID (e.g. --uninstall "My Extension").');
        process.exit(2);
      }
      process.exitCode = await uninstallAddon(query, values.profile, values.firefox, !values["no-firefox-restart"]);
      return;
    }
    if (values.logs !== undefined) {
      const query = values.logs.trim();
      if (!query) {
        fail('--logs needs an add-on name or ID (e.g. --logs "My Extension").');
        process.exit(2);
      }
      process.exitCode = printLogs(query, values.profile, values.firefox);
      return;
    }
  } catch (e) {
    fail((e as Error).message);
    process.exit(1);
  }

  const inputs = positionals;
  if (inputs.length === 0) {
    fail("Missing <input> (a .zip, .crx, .xpi, extension directory, or URL).");
    console.log(HELP);
    process.exit(2);
  }

  const usage = (msg: string): never => {
    fail(msg);
    process.exit(2);
  };
  const platforms = values.platforms as Platforms;
  if (!["all", "desktop", "android"].includes(platforms)) usage(`Invalid --platforms "${platforms}". Use desktop | android | all.`);
  if (!SIGN_ROUTES.includes(values.sign)) usage(`Invalid --sign "${values.sign}". Use ${SIGN_ROUTES.join(" | ")}.`);
  if (values.headless && (values.sign === "amo" || values.sign === "unsigned")) usage("--headless only applies to --sign temporary.");
  const sign = values.sign as SignRoute | "auto";
  if (values.install && platforms === "android") usage("--install targets desktop Firefox; use --platforms desktop or all.");
  if (values.verify && !values.install) usage("--verify requires --install (it checks the installed add-on).");
  if (values.headless && !values.install) usage("--headless requires --install (it is a way to install).");
  if (values.debug && values["no-shim"]) usage("--debug enables the shim's debug tracing; remove --no-shim.");
  if (values["native-hosts"] && values["no-native-hosts"]) usage("--native-hosts and --no-native-hosts contradict each other; pick one.");
  if (values["addon-id"] !== undefined && !isAmoAddonId(values["addon-id"])) {
    usage(`Invalid --addon-id "${values["addon-id"]}". Use an ID like name@example.com or a {UUID}: at most 80 letters, digits, ".", "_" or "-".`);
  }
  if (values["min-firefox"] !== undefined && !MIN_FIREFOX_RE.test(values["min-firefox"])) {
    usage(`Invalid --min-firefox "${values["min-firefox"]}". Use a version like ${DEFAULT_MIN_FIREFOX} (1 to 4 numbers).`);
  }
  if (values["addon-version"] !== undefined && !ADDON_VERSION_RE.test(values["addon-version"])) {
    usage(`Invalid --addon-version "${values["addon-version"]}". Use 1 to 4 numbers without leading zeros, like 1.2.3.4.`);
  }
  const dataCollection = values["data-collection"] !== undefined ? parseDataCollection(values["data-collection"]) : undefined;
  if (values.json && !values.analyze) usage("--json is only valid with --analyze.");
  if (values.report !== undefined && !values.analyze) usage("--report is only valid with --analyze.");

  // Single-file and per-extension settings can't apply to several inputs.
  if (inputs.length > 1) {
    // A config value is a shared default, so it's dropped with a note; only a
    // flag the user typed fails the run.
    for (const key of ["output", "addon-id", "addon-version"] as const) {
      if (config.applied.has(key) && values[key] !== undefined) {
        warn(`Config "${key}" ignored for batch runs (it applies to a single extension).`);
        values[key] = undefined;
      }
    }
    if (values.output !== undefined) usage("--output names a single directory; omit it for a batch (each extension gets its own ./<Name>_Firefox).");
    if (values.report !== undefined) usage("--report names a single file; omit it for batch runs.");
    if (values.json) usage("--json prints one object per extension; analyze one extension at a time for parseable JSON.");
    if (values["addon-id"] !== undefined || values["addon-version"] !== undefined) {
      usage("--addon-id and --addon-version apply to one extension; omit them for a batch.");
    }
  }

  let credentials: AmoCredentials | undefined;
  if (!values.analyze) {
    try {
      credentials = resolveAmoCredentials(flagCredentials, config.credentials);
    } catch (e) {
      usage((e as Error).message);
    }
    if (sign === "amo" && !credentials) usage(AMO_CREDENTIALS_MISSING);
  }

  // Name the version in every run: reports of "the fix didn't work" start there.
  info(`${NAME} ${pkgVersion()}`);

  const settings = {
    platforms,
    minFirefoxVersion: values["min-firefox"],
    addonId: values["addon-id"],
    addonVersion: values["addon-version"],
    dataCollection,
    generateShim: !values["no-shim"],
    oauthBridge: !values["no-oauth-bridge"],
    debug: values.debug,
    panelQuery: values["panel-query"],
  };

  const batch = inputs.length > 1;
  let anyFailed = false;
  // Two inputs of a batch can share a name; each still gets its own folder.
  const claimedOutputs = batch ? new Set<string>() : undefined;
  // Download scratch dirs in flight. Each is removed when its input is done, but
  // process.exit() skips that, so one exit handler drains whatever is left.
  const liveScratch = new Set<string>();
  process.on("exit", () => {
    for (const d of liveScratch) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // One dir that won't go must not stop the rest.
      }
    }
  });
  // Signals skip 'exit' handlers, so route them through process.exit, a tick
  // later so convert()'s own cleanup runs first.
  const onSignal = () => {
    setImmediate(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // An input that can't be read fails only itself. --analyze --json answers in
  // JSON, as analyzeOnly does, and stdout is left to drain rather than cut off by exit().
  const inputFailed = (msg: string) => {
    if (values.analyze && values.json) console.log(JSON.stringify({ error: msg, convertible: false }, null, 2));
    else fail(msg);
    anyFailed = true;
  };

  for (const input of inputs) {
    if (batch) console.error(`\n${color("bold", `── ${basename(input)} ──`)}`);

    // Checked per input, so one bad path doesn't stop the rest of a batch.
    if (!isUrl(input) && !existsSync(input)) {
      inputFailed(`Input not found: ${input}`);
      continue;
    }

    let localInput = input;
    let dlScratch: string | undefined;
    try {
      if (isUrl(input)) {
        info(`Downloading extension from ${input} …`);
        dlScratch = mkdtempSync(join(tmpdir(), `${NAME}-dl-`));
        liveScratch.add(dlScratch);
        try {
          localInput = await downloadExtension(input, dlScratch);
        } catch (e) {
          inputFailed((e as Error).message);
          continue;
        }
        ok(`Downloaded → ${basename(localInput)}`);
      }

      if (values.analyze) {
        if (analyzeOnly(localInput, settings, values.json, values.strict, values.report) !== 0) anyFailed = true;
        continue;
      }

      let result;
      try {
        result = await convert({
          ...settings,
          input: localInput,
          output: values.output,
          force: values.force,
          strict: values.strict,
          clean: values.clean,
          zip: values.zip,
          sign,
          amo: credentials,
          install: values.install,
          profile: values.profile,
          firefox: values.firefox,
          verify: values.verify,
          firefoxRestart: !values["no-firefox-restart"],
          launch: !values["no-launch"],
          headless: values.headless,
          nativeHosts: values["no-native-hosts"] ? false : values["native-hosts"] ? true : undefined,
          claimedOutputs,
        });
      } catch (e) {
        fail((e as Error).message);
        if (!batch) process.exit(1);
        anyFailed = true;
        continue;
      }

      console.log("");
      if (!result.success) {
        fail("Conversion did not complete. See messages above.");
        anyFailed = true;
        continue;
      }
      ok(color("bold", `Done: ${result.extensionName}`));
      const rows: Array<[string, string | undefined]> = [
        ["Signed", result.signedXpiPath],
        [result.signedXpiPath ? "Unsigned" : "Add-on", result.xpiPath],
        ["Zip", result.zipPath],
        ["Staged", result.stagedPath],
        ["ID", result.addonId],
        ["Profile", result.profilePath],
      ];
      for (const [label, value] of rows) if (value) console.log(`  ${`${label}:`.padEnd(10)}${value}`);
      if (!result.route) {
        console.log("  Install: re-run with --install, or load the .xpi from about:debugging → This Firefox →");
        console.log("  Load Temporary Add-on. Release and Beta Firefox keep only signed add-ons: sign it");
        console.log("  through AMO with --sign amo, or use Nightly, Developer Edition or ESR.");
      } else if (result.route === "amo" && !result.profilePath) {
        console.log("  Install: open the signed .xpi in Firefox, or re-run with --install.");
      } else if (result.route === "temporary" && result.profilePath && !values.headless) {
        console.log("  Firefox loads the add-on from the staged folder: keep it in place while Firefox runs.");
      }
      // The add-on was built, but the install the user asked for didn't happen.
      if (result.installFailed) anyFailed = true;
    } finally {
      // Free this input's download now rather than at exit, so a long batch
      // doesn't pile up archives.
      if (dlScratch) {
        rmSync(dlScratch, { recursive: true, force: true });
        liveScratch.delete(dlScratch);
      }
    }
  }

  if (batch) {
    const n = inputs.length;
    if (anyFailed) fail(`Batch finished with failures (${n} input(s)). See messages above.`);
    else ok(color("bold", `Batch complete: ${n} extension(s).`));
  }
  // process.exit() can cut off a piped --analyze --json payload; let stdout drain.
  process.exitCode = anyFailed ? 1 : 0;
}

main().catch((e) => {
  fail((e as Error).message);
  process.exit(1);
});
