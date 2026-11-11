import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ConvertOptions, ConvertResult, Issue, Manifest, SignRoute } from "./types.js";
import { ENV_PREFIX, NAME } from "./name.js";
import { extractExtension } from "./input/extract.js";
import { applySourceRewrites, stageExtension, stripDanglingSourcemaps } from "./input/stage.js";
import { synthesizePlaceholderIcons } from "./input/icons.js";
import {
  analyzeManifest,
  collectReferencedPaths,
  DEFAULT_MIN_FIREFOX,
  loadManifest,
  resolveI18nString,
  toFirefoxVersion,
  transformManifest,
  writeManifest,
} from "./manifest/manifest.js";
import { compareFirefoxVersions } from "./manifest/compat-data.js";
import { applyDnr, GUARANTEED_MINIMUM_STATIC_RULES, STATIC_RULES_PREF, CHROME_STATIC_RULE_LIMIT } from "./manifest/dnr.js";
import { scanExtension } from "./analyze/analyze.js";
import { countBlocking, printIssues, summarizeManifestChanges, writeReportFile, type ReportMeta } from "./analyze/report.js";
import {
  backendHosts,
  derivePanelPage,
  derivePanelWindowQuery,
  injectShimIntoHtmlPages,
  usesDebugger,
  wireBackground,
  workerChunkGlobal,
  writeShim,
} from "./runtime/shim.js";
import { applyOAuthBridge, deriveChromeId } from "./runtime/oauth-bridge.js";
import { deriveAddonId } from "./sign/addon-id.js";
import { signWithAmo } from "./sign/amo.js";
import { zipDirectory } from "./zip/write.js";
import { findFirefoxInstalls, selectFirefox, type FirefoxInstall } from "./firefox/locate.js";
import { dedicatedProfile, profileInUse, resolveProfile, type FirefoxProfile } from "./firefox/profiles.js";
import { openXpiInFirefox, quitFirefoxForProfile, startedBeforeUserJs } from "./firefox/launch.js";
import { BidiSession } from "./firefox/bidi.js";
import { RdpSession } from "./firefox/rdp.js";
import {
  allowUnsignedInProfile,
  DEBUGGER_SERVER_PREFS,
  enableDebuggerServerInProfile,
  raiseStaticRuleLimitInProfile,
  recordInstall,
  waitForAddon,
} from "./firefox/install.js";
import { registerNativeHosts } from "./firefox/native-hosts.js";
import { DEBUG_LOG_KEY } from "./firefox/storage.js";
import { fail, info, ok, warn } from "./util.js";

/** The staged add-on's folder inside the output directory. */
const STAGE_DIR = "staged_extension";
/** How long --verify waits for the user to accept Firefox's install prompt. */
const VERIFY_TIMEOUT_MS = 120_000;

export const AMO_CREDENTIALS_MISSING =
  `The amo route needs AMO API credentials: pass --amo-key and --amo-secret, or set ${ENV_PREFIX}_AMO_KEY and ` +
  `${ENV_PREFIX}_AMO_SECRET (web-ext's WEB_EXT_API_KEY and WEB_EXT_API_SECRET work too). ` +
  "Create them at https://addons.mozilla.org/developers/addon/api/key/.";

/** What to tell the user when no Firefox matches; --doctor uses the same words. */
export function noFirefoxMessage(selector?: string): string {
  return selector
    ? `No Firefox matches --firefox "${selector}". Pass a channel (release, beta, nightly, esr, developer-edition) ` +
        "or the path to a Firefox, and run --doctor to see the installs found."
    : "No Firefox install found. Install Firefox from https://www.mozilla.org/firefox/, or pass --firefox " +
        "with the path to one, and run --doctor to see the installs found.";
}

/** The Firefox install --firefox selects (release by default); throws with the fix when there is none. */
export function findFirefox(selector?: string): FirefoxInstall {
  const install = selectFirefox(findFirefoxInstalls(), selector);
  if (!install) throw new Error(noFirefoxMessage(selector));
  return install;
}

/**
 * File and folder name for an extension: its name without spaces or punctuation.
 * Combining marks stay with their letters (Indic vowel signs, accents), and the
 * name is composed first, so a decomposed spelling gives the same name. Windows
 * keeps device names like CON and COM1 with any extension (Con.xpi), so those get
 * a trailing "_" on every OS.
 */
function deriveAppName(name: string): string {
  const stripped = name.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "") || "Extension";
  return /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(stripped) ? `${stripped}_` : stripped;
}

/**
 * The real path of `p`, with the case the file system stores. A path that doesn't
 * exist yet, like a new output directory, is resolved through its nearest existing
 * ancestor, so a symlink or a differently cased name above it can't hide where it lies.
 */
function realPathOf(p: string): string {
  const tail: string[] = [];
  for (let dir = resolve(p); ; dir = dirname(dir)) {
    try {
      return join(realpathSync.native(dir), ...tail);
    } catch {
      if (dirname(dir) === dir) return resolve(p);
      tail.unshift(basename(dir));
    }
  }
}

/** True when `child` is `parent` or lies below it. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

export interface RouteChoice {
  route: SignRoute;
  /** Why, as printed next to the Signing line. */
  reason: string;
}

/**
 * Resolve --sign. auto takes the first route that works: AMO when credentials are set,
 * unsigned when the target Firefox honours xpinstall.signatures.required, else a
 * temporary install. A forced route that can't work throws with the reason.
 */
export function chooseRoute(
  requested: SignRoute | "auto",
  hasCredentials: boolean,
  firefox?: Pick<FirefoxInstall, "channel" | "version" | "requireSigning">,
): RouteChoice {
  const which = firefox ? `Firefox ${firefox.version} (${firefox.channel})` : "";
  if (requested === "amo") {
    if (!hasCredentials) throw new Error(AMO_CREDENTIALS_MISSING);
    return { route: "amo", reason: "requested with --sign amo" };
  }
  if (requested === "unsigned") {
    if (firefox?.requireSigning) {
      throw new Error(
        `${which} only installs signed add-ons and ignores xpinstall.signatures.required. Use Nightly, ` +
          "Developer Edition, ESR or an unbranded build (--firefox <channel|path>), or --sign amo or --sign temporary.",
      );
    }
    return { route: "unsigned", reason: "requested with --sign unsigned" };
  }
  if (requested === "temporary") return { route: "temporary", reason: "requested with --sign temporary" };
  if (hasCredentials) return { route: "amo", reason: "AMO credentials are set" };
  if (firefox && !firefox.requireSigning) return { route: "unsigned", reason: `${which} can run unsigned add-ons` };
  return {
    route: "temporary",
    reason: `${which || "Firefox"} only installs signed add-ons and no AMO credentials are set`,
  };
}

/** A scratch directory that goes away when the run ends, including on Ctrl-C. */
function scratchDir(): { path: string; dispose(): void } {
  const path = mkdtempSync(join(tmpdir(), `${NAME}-`));
  const cleanup = () => rmSync(path, { recursive: true, force: true });
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return {
    path,
    dispose() {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      cleanup();
    },
  };
}

interface Log {
  ok(msg: string): void;
  warn(msg: string): void;
}

type BuildSettings = Pick<
  ConvertOptions,
  "platforms" | "minFirefoxVersion" | "addonVersion" | "dataCollection" | "generateShim" | "oauthBridge" | "debug" | "panelQuery"
>;

/**
 * Stage the extension and turn it into a Firefox add-on: source rewrites, the shim,
 * the Firefox manifest, DNR rules, the page bridge, the background scripts and
 * placeholder icons. Writes the final manifest.json and returns it, with the number
 * of static DNR rules the add-on carries. --analyze runs this on a scratch copy, so
 * its preview is exactly what a conversion produces.
 */
function buildAddon(
  src: { extPath: string; manifest: Manifest; permissionsToRemove: string[]; name: string; chromeId?: string; addonId: string },
  stageDir: string,
  settings: BuildSettings,
  log: Log,
): { manifest: Manifest; staticRules: number } {
  const { manifest } = src;
  for (const asset of stageExtension(src.extPath, stageDir, collectReferencedPaths(manifest))) {
    log.warn(`Manifest-referenced asset not staged (broken/external symlink or copy error): ${asset}. It will 404 in Firefox.`);
  }
  for (const r of applySourceRewrites(stageDir, manifest)) {
    if (r.count > 0) log.ok(`${r.name} in ${r.count} file(s)`);
  }

  // The side panel's page, when the manifest declares none and the code passes it
  // to chrome.sidePanel.setOptions, and the query its window form needs.
  const panelPage = derivePanelPage(stageDir, manifest);
  const panelQuery = settings.panelQuery ?? derivePanelWindowQuery(stageDir, manifest);
  const debuggerEmulation = settings.generateShim && usesDebugger(stageDir, manifest);

  let shimFile: string | undefined;
  if (settings.generateShim) {
    const bg = manifest.background;
    shimFile = writeShim(stageDir, {
      debug: settings.debug === true,
      sidePanelPath: manifest.side_panel?.default_path ?? panelPage,
      // A page found in the code means the manifest declares no panel for all tabs.
      noDefaultPanel: panelPage !== "",
      panelQuery,
      extensionId: src.chromeId,
      debuggerEmulation,
      serviceWorker: typeof bg?.service_worker === "string" && !Array.isArray(bg.scripts) && !bg.page,
      serviceWorkerScript: typeof bg?.service_worker === "string" ? bg.service_worker : "",
      backendHosts: backendHosts(manifest),
      userScripts: [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].includes("userScripts"),
      webpackChunkGlobal: workerChunkGlobal(stageDir, manifest),
      declaredPermissions: [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].filter((p): p is string => typeof p === "string"),
    });
    if (settings.debug) {
      log.ok(`Debug build: shim tracing on, kept in storage.local under ${DEBUG_LOG_KEY} (read it with ${NAME} --logs). Don't ship this build.`);
    }
    if (debuggerEmulation) log.ok("chrome.debugger emulated on scripting, tabs, webNavigation and webRequest");
    const pages = injectShimIntoHtmlPages(stageDir, shimFile);
    if (pages > 0) log.ok(`Shim injected into ${pages} HTML page(s)`);
  }

  const out = transformManifest(manifest, src.permissionsToRemove, {
    addonId: src.addonId,
    minFirefoxVersion: settings.minFirefoxVersion ?? DEFAULT_MIN_FIREFOX,
    platforms: settings.platforms,
    version: settings.addonVersion ?? toFirefoxVersion(manifest.version ?? ""),
    dataCollection: settings.dataCollection,
    contentScriptPrepend: shimFile ? [shimFile] : [],
    sidebarPanelQuery: panelQuery,
    sidebarPanel: panelPage,
    debuggerEmulation,
  });
  if (!manifest.side_panel && out.sidebar_action && panelPage) {
    log.ok(`Sidebar declared for ${panelPage}, the page the extension opens with chrome.sidePanel`);
  }
  if (out.sidebar_action && panelQuery) {
    log.ok(
      settings.panelQuery !== undefined
        ? `Sidebar page opens with ?${panelQuery.replace(/^\?/, "")} (--panel-query)`
        : `Sidebar page opens with ?${panelQuery}, the query the extension uses for the page's own window mode`,
    );
  }

  const dnr = applyDnr(stageDir, out);
  for (const note of dnr.notes) log.warn(note);
  if (settings.oauthBridge !== false) {
    for (const note of applyOAuthBridge(stageDir, out, src.chromeId)) log.ok(note);
  }
  const bg = wireBackground(stageDir, out, shimFile);
  if (bg.converted) {
    log.ok(`Service worker → background.scripts${bg.hoisted.length ? `, importScripts hoisted: ${bg.hoisted.join(", ")}` : ""}`);
  }
  const icons = synthesizePlaceholderIcons(stageDir, out, src.name);
  if (icons.length > 0) log.ok(`Synthesized placeholder icons (${icons.join("/")}px); the manifest had none`);
  const maps = stripDanglingSourcemaps(stageDir);
  if (maps > 0) log.ok(`Stripped dangling sourcemap refs from ${maps} script(s)`);

  writeManifest(stageDir, out);
  return { manifest: out, staticRules: dnr.staticRules };
}

/** Extract an input and read its manifest and identity. */
function load(input: string, scratch: string, minFirefox: string) {
  const extPath = extractExtension(resolve(input), scratch);
  const manifest = loadManifest(extPath);
  const name = resolveI18nString(manifest.name, extPath, manifest.default_locale) ?? manifest.name ?? "Unknown";
  return { extPath, manifest, name, chromeId: deriveChromeId(manifest), minFirefox };
}

function issuesOf(extPath: string, manifest: Manifest, minFirefox: string) {
  const { issues, permissionsToRemove } = analyzeManifest(manifest, { minFirefox });
  return { issues: [...issues, ...scanExtension(extPath, manifest, { minFirefox })], permissionsToRemove };
}

export type AnalyzeOptions = Pick<ConvertOptions, "input" | "addonId"> & BuildSettings;

export interface Analysis {
  name: string;
  appName: string;
  addonId: string;
  /** The extension's own version, before conversion. */
  version?: string;
  manifestVersion: number;
  issues: Issue[];
  removedPermissions: string[];
  /** What the conversion would change in the manifest. */
  manifestChanges: string[];
}

/**
 * Analyze an extension without converting it. The manifest changes come from a real
 * build on a scratch copy, so they match what a conversion writes. Throws when the
 * input can't be extracted or has no readable manifest.
 */
export function analyzeExtension(opts: AnalyzeOptions): Analysis {
  const scratch = scratchDir();
  try {
    const src = load(opts.input, scratch.path, opts.minFirefoxVersion ?? DEFAULT_MIN_FIREFOX);
    const { issues, permissionsToRemove } = issuesOf(src.extPath, src.manifest, src.minFirefox);
    const addonId = opts.addonId ?? deriveAddonId({ chromeId: src.chromeId, name: src.name });
    const quiet: Log = { ok() {}, warn() {} };
    const { manifest: built } = buildAddon({ ...src, permissionsToRemove, addonId }, join(scratch.path, STAGE_DIR), opts, quiet);
    return {
      name: src.name,
      appName: deriveAppName(src.name),
      addonId,
      version: src.manifest.version,
      manifestVersion: src.manifest.manifest_version ?? 3,
      issues,
      removedPermissions: permissionsToRemove,
      manifestChanges: summarizeManifestChanges(src.manifest, built),
    };
  } finally {
    scratch.dispose();
  }
}

interface InstallTarget {
  install: FirefoxInstall;
  profile: FirefoxProfile;
}

interface Plan {
  /** Unset when there's nothing to sign or install: the run ends at the unsigned .xpi. */
  route?: RouteChoice;
  target?: InstallTarget;
}

/**
 * Decide the route and, with --install, the Firefox and profile, before any work is
 * done, so a missing Firefox or profile fails the run at once.
 */
function planRoute(opts: ConvertOptions, minFirefox: string): Plan {
  const hasCredentials = opts.amo !== undefined;
  if (!opts.install) {
    // Without an install only signing has anything to do.
    if (opts.sign === "amo" || (opts.sign === "auto" && hasCredentials)) return { route: chooseRoute(opts.sign, hasCredentials) };
    return {};
  }
  const install = findFirefox(opts.firefox);
  // A Firefox without a window can't show an install prompt.
  const route: RouteChoice =
    opts.headless && opts.sign === "auto"
      ? { route: "temporary", reason: "--headless loads the add-on temporarily" }
      : chooseRoute(opts.sign, hasCredentials, install);
  if (opts.platforms !== "android" && compareFirefoxVersions(install.version, minFirefox) < 0) {
    throw new Error(
      `Firefox ${install.version} is older than ${minFirefox}, the add-on's minimum version, and would refuse it. ` +
        "Update Firefox, pick another with --firefox, or lower --min-firefox.",
    );
  }
  if (route.route === "temporary" && !opts.launch) {
    throw new Error(
      "A temporary install loads the add-on into a Firefox started for it, so it can't run with --no-launch. " +
        "Drop --no-launch, or pick --sign amo or --sign unsigned.",
    );
  }
  // The temporary route turns remote debugging on in a profile of its own, not the user's, unless told otherwise.
  const profile =
    route.route === "temporary" && opts.profile === undefined ? dedicatedProfile(install) : resolveProfile(opts.profile, install);
  return { route, target: { install, profile } };
}

/**
 * Snap and Flatpak Firefox only see part of the file system, and Firefox reads the
 * add-on from where it lies. Returns the warning to print when `path` is out of view.
 */
function sandboxProblem(install: FirefoxInstall, path: string): string | undefined {
  const inside = (parent: string) => {
    const rel = relative(parent, resolve(path));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
  };
  if (install.sandbox === "snap") {
    const rel = inside(homedir());
    if (rel !== undefined && !rel.split(sep).some((part) => part.startsWith("."))) return undefined;
    return `Snap Firefox only reads folders in your home directory that aren't hidden, so it can't load ${path}. Pass --output with a folder like ~/${NAME}-addons.`;
  }
  if (install.sandbox === "flatpak" && inside(join(homedir(), "Downloads")) === undefined) {
    return `Flatpak Firefox only reads your Downloads folder, so it can't load ${path}. Pass --output with a folder under ~/Downloads.`;
  }
  return undefined;
}

type InstallOutcome = "installed" | "skipped" | "failed";

/**
 * Give the profile Chrome's room for static DNR rules when the add-on carries
 * more than Firefox allows one by default; Firefox reads the pref when it
 * starts. True when the profile's user.js changed.
 */
function raiseRuleLimit(profilePath: string, staticRules: number): boolean {
  if (staticRules <= GUARANTEED_MINIMUM_STATIC_RULES || !raiseStaticRuleLimitInProfile(profilePath).changed) return false;
  ok(
    `The add-on has ${staticRules} static DNR rules, past Firefox's default of ${GUARANTEED_MINIMUM_STATIC_RULES} per add-on: ` +
      `set ${STATIC_RULES_PREF} to Chrome's ${CHROME_STATIC_RULE_LIMIT} in ${join(profilePath, "user.js")}`,
  );
  return true;
}

const RULE_LIMIT_RESTART = "Firefox has the profile open and reads the rule limit when it starts; restart it for all of the add-on's rules to load.";

/**
 * The temporary route: Firefox loads the staged folder in place through its
 * devtools server, the way web-ext run does. Unlike WebDriver, that server
 * leaves navigator.webdriver false, so sign-in pages don't take Firefox for a bot.
 */
async function installTemporarily(
  { install, profile }: InstallTarget,
  stageDir: string,
  addonId: string,
  staticRules: number,
  opts: ConvertOptions,
): Promise<InstallOutcome> {
  if (opts.headless) return installHeadless({ install, profile }, stageDir, addonId, staticRules);
  // A Firefox that an earlier temporary install started still has its devtools
  // server: load this add-on next to the others rather than restart it,
  // which would drop them.
  let session = await RdpSession.attach(profile.path);
  if (session) {
    info(`Using the Firefox that already has ${profile.path} open with remote debugging on`);
    if (raiseRuleLimit(profile.path, staticRules)) warn(RULE_LIMIT_RESTART);
  } else {
    if (profileInUse(profile.path)) {
      if (!opts.firefoxRestart) {
        fail(
          `Firefox has the profile at ${profile.path} open. A temporary install has to restart it with remote debugging on; ` +
            "quit Firefox first, or drop --no-firefox-restart.",
        );
        return "failed";
      }
      info(`Quitting the Firefox that has ${profile.path} open, to restart it with remote debugging on …`);
      if (!(await quitFirefoxForProfile(install, profile.path))) {
        fail(`Couldn't quit the Firefox that has ${profile.path} open. Quit it yourself, then run this again.`);
        return "failed";
      }
    }
    if (enableDebuggerServerInProfile(profile.path).changed) {
      const prefs = Object.entries(DEBUGGER_SERVER_PREFS).map(([name, value]) => `${name} = ${value}`);
      ok(`Turned on remote debugging in ${join(profile.path, "user.js")} (${prefs.join(", ")})`);
    }
    raiseRuleLimit(profile.path, staticRules);
    session = await RdpSession.start(install, profile.path);
  }
  let id: string;
  try {
    id = await session.installTemporaryAddon(stageDir);
  } finally {
    session.end();
  }
  ok(`Installed → ${profile.path}`);
  if (id !== addonId) warn(`Firefox loaded the add-on as ${id}, not ${addonId}.`);
  info(`Loaded ${id} temporarily: Firefox removes it when it quits.`);
  return "installed";
}

/**
 * --headless: a windowless Firefox loads the add-on over WebDriver BiDi and
 * quits again. BiDi can close Firefox cleanly, and nobody browses in that
 * Firefox, so the navigator.webdriver it sets doesn't matter there.
 */
async function installHeadless({ install, profile }: InstallTarget, stageDir: string, addonId: string, staticRules: number): Promise<InstallOutcome> {
  if (profileInUse(profile.path)) {
    fail(`Firefox has the profile at ${profile.path} open. --headless needs a profile no Firefox has open; quit it, or pass another --profile.`);
    return "failed";
  }
  raiseRuleLimit(profile.path, staticRules);
  const session = await BidiSession.start(install, profile.path);
  let id: string;
  try {
    id = await session.installExtension(stageDir);
  } catch (err) {
    await session.closeBrowser().catch(() => {});
    throw err;
  }
  ok(`Installed → ${profile.path}`);
  if (id !== addonId) warn(`Firefox loaded the add-on as ${id}, not ${addonId}.`);
  await session.closeBrowser();
  info(`Firefox loaded ${id} and has quit again (--headless); temporary add-ons go with it.`);
  return "installed";
}

/** The amo and unsigned routes: Firefox shows its install prompt for the .xpi. */
async function installByPrompt(
  { install, profile }: InstallTarget,
  route: SignRoute,
  xpi: string,
  staticRules: number,
  opts: ConvertOptions,
): Promise<InstallOutcome> {
  if (route === "unsigned") {
    const running = profileInUse(profile.path);
    const changed = allowUnsignedInProfile(profile.path).changed;
    if (changed) ok(`Turned off signature checks in ${join(profile.path, "user.js")} (xpinstall.signatures.required = false)`);
    // Also when the pref was already there but this Firefox started before it
    // was written, e.g. by an earlier run under --no-firefox-restart or --no-launch.
    if ((changed && running) || startedBeforeUserJs(install, profile.path)) {
      if (!changed) info(`The Firefox that has ${profile.path} open started before signature checks were turned off in its user.js.`);
      if (!opts.firefoxRestart || !opts.launch) {
        warn(
          `Firefox has ${profile.path} open and reads that setting only when it starts. ` +
            `Quit Firefox and start it again, then open ${xpi} in it to install the add-on.`,
        );
        return "skipped";
      }
      info("Restarting Firefox so the setting takes effect …");
      if (!(await quitFirefoxForProfile(install, profile.path))) {
        fail(`Couldn't quit the Firefox that has ${profile.path} open. Quit it yourself, then run this again.`);
        return "failed";
      }
    }
  }
  if (raiseRuleLimit(profile.path, staticRules) && profileInUse(profile.path)) warn(RULE_LIMIT_RESTART);
  if (!opts.launch) {
    info(`Not starting Firefox (--no-launch). Open ${xpi} in Firefox with the profile at ${profile.path} to install it.`);
    return "skipped";
  }
  openXpiInFirefox(install, profile, xpi);
  ok(`Installed → ${profile.path}`);
  info("Firefox is showing its install prompt; click Add to finish.");
  return "installed";
}

export async function convert(opts: ConvertOptions): Promise<ConvertResult> {
  const result: ConvertResult = {
    success: false,
    extensionName: "Unknown",
    manifestVersion: 3,
    issues: [],
  };
  const scratch = scratchDir();
  try {
    info(`Extracting ${basename(opts.input)} …`);
    const src = load(opts.input, scratch.path, opts.minFirefoxVersion ?? DEFAULT_MIN_FIREFOX);
    result.extensionName = src.name;
    result.manifestVersion = src.manifest.manifest_version ?? 3;
    result.chromeId = src.chromeId;
    ok(`Loaded "${src.name}" (MV${result.manifestVersion})`);

    const { issues, permissionsToRemove } = issuesOf(src.extPath, src.manifest, src.minFirefox);
    result.issues = issues;
    const blocking = countBlocking(issues, opts.strict);
    if (blocking > 0 && !opts.force) {
      printIssues(issues);
      const what = opts.strict ? "blocking issue(s) (--strict: warnings count)" : "blocking error(s)";
      fail(`${blocking} ${what}. Re-run with --force to convert anyway.`);
      return result;
    }

    const addonId = opts.addonId ?? deriveAddonId({ chromeId: src.chromeId, name: src.name });
    result.addonId = addonId;
    const plan = planRoute(opts, src.minFirefox);

    const appName = deriveAppName(src.name);
    let outputDir = resolve(opts.output ?? join(process.cwd(), `${appName}_Firefox`));
    if (opts.output === undefined && opts.claimedOutputs) {
      const taken = outputDir;
      for (let n = 2; opts.claimedOutputs.has(realPathOf(outputDir)); n++) outputDir = resolve(`${appName}_Firefox_${n}`);
      if (outputDir !== taken) warn(`${taken} holds the add-on converted from an earlier input in this batch; writing this one to ${outputDir}.`);
    }
    // Refuse overlapping input and output before anything destructive: staging
    // recreates its folder and --clean wipes the output directory.
    const [realExt, realOut] = [realPathOf(src.extPath), realPathOf(outputDir)];
    if (isInside(realExt, realOut)) {
      fail(`Input extension (${src.extPath}) lives inside the output directory (${outputDir}); converting would delete it. Pass -o <dir> outside the input.`);
      return result;
    }
    if (isInside(realOut, realExt)) {
      fail(`Output directory (${outputDir}) is inside the input extension; staging cannot copy a directory into itself. Pass -o <dir> outside the input.`);
      return result;
    }
    // An archive input is extracted to scratch, so the checks above can't see it;
    // the output files and --clean can still destroy the archive itself.
    const stageDir = join(outputDir, STAGE_DIR);
    const xpiPath = join(outputDir, `${appName}.xpi`);
    const zipPath = opts.zip ? join(outputDir, `${appName}.zip`) : undefined;
    if (statSync(opts.input).isFile()) {
      const realInput = realPathOf(opts.input);
      const target = [xpiPath, zipPath].find((p) => p !== undefined && realPathOf(p) === realInput);
      if (target || isInside(realInput, realPathOf(stageDir))) {
        fail(`The output would overwrite the input ${opts.input}${target ? ` with ${basename(target)}` : ""}. Pass -o <dir> elsewhere.`);
        return result;
      }
      if (opts.clean && isInside(realInput, realOut)) {
        fail(`The input ${opts.input} lives in the output directory (${outputDir}), which --clean deletes. Pass -o <dir> elsewhere, or drop --clean.`);
        return result;
      }
    }
    if (opts.clean && existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
      ok(`Cleaned output dir → ${outputDir}`);
    }
    mkdirSync(outputDir, { recursive: true });
    opts.claimedOutputs?.add(realPathOf(outputDir));

    // Kept in the output directory: a temporary install loads it in place.
    info("Staging clean extension assets …");
    const { manifest: built, staticRules } = buildAddon({ ...src, permissionsToRemove, addonId }, stageDir, opts, { ok, warn });
    const version = built.version ?? "";
    result.stagedPath = stageDir;
    result.version = version;
    ok(`Staged → ${stageDir}`);

    const meta: ReportMeta = {
      name: src.name,
      version,
      manifestVersion: result.manifestVersion,
      platforms: opts.platforms,
      removedPermissions: permissionsToRemove,
      manifestChanges: summarizeManifestChanges(src.manifest, built),
      strict: opts.strict,
    };
    const reportPath = writeReportFile(outputDir, meta, issues);
    ok(`Report → ${reportPath}`);

    info("Packing .xpi");
    let packed: { version: string; xpiPath: string; sha256: string } | undefined;
    // AMO may need the add-on packed again under a higher version.
    const pack = (v: string) => {
      if (packed?.version === v) return packed;
      if (built.version !== v) {
        built.version = v;
        writeManifest(stageDir, built);
      }
      zipDirectory(stageDir, xpiPath);
      if (zipPath) copyFileSync(xpiPath, zipPath);
      packed = { version: v, xpiPath, sha256: createHash("sha256").update(readFileSync(xpiPath)).digest("hex") };
      return packed;
    };
    pack(version);
    result.xpiPath = xpiPath;
    result.zipPath = zipPath;
    ok(`Packed → ${xpiPath}`);
    if (zipPath) ok(`Zipped the unsigned add-on → ${zipPath}`);

    // Firefox reads host manifests when the add-on connects, so they go in before
    // any install starts it.
    const permitted = [...(built.permissions ?? []), ...(built.optional_permissions ?? [])].includes("nativeMessaging");
    if (permitted && (opts.nativeHosts ?? opts.install)) {
      for (const r of registerNativeHosts({ dir: stageDir, addonId, chromeId: src.chromeId })) {
        if (r.outcome === "skipped") warn(`Native app ${r.name} not registered for Firefox: ${r.detail}.`);
        else if (r.outcome === "present") info(`Native app ${r.name}: ${r.detail}`);
        else ok(`Native app ${r.name}: ${r.detail}`);
      }
    }

    if (!plan.route) {
      result.success = true;
      printIssues(issues);
      return result;
    }

    const route = plan.route.route;
    result.route = route;
    info(`Signing (${route}): ${plan.route.reason}`);
    let installable = xpiPath;
    let installVersion = version;
    if (route === "amo") {
      const credentials = opts.amo;
      if (!credentials) throw new Error(AMO_CREDENTIALS_MISSING);
      const outcome = await signWithAmo({ addonId, baseVersion: version, credentials, pack, outDir: outputDir });
      if (outcome.kind === "pending") {
        printIssues(issues);
        fail(`AMO hasn't signed version ${outcome.version} yet. Run the same command again later to pick up the signed file.`);
        return result;
      }
      if (outcome.kind === "rejected") {
        issues.push(...outcome.issues);
        writeReportFile(outputDir, meta, issues);
        printIssues(issues);
        fail(`AMO rejected ${outcome.version ? `version ${outcome.version} of ` : ""}the add-on. See the issues above or ${reportPath}.`);
        return result;
      }
      if (outcome.version !== version) writeReportFile(outputDir, { ...meta, version: outcome.version }, issues);
      result.signedXpiPath = outcome.signedXpiPath;
      result.version = installVersion = outcome.version;
      installable = outcome.signedXpiPath;
      ok(`Signed by AMO → ${outcome.signedXpiPath}`);
    }

    if (plan.target) {
      const { install, profile } = plan.target;
      const sandboxed = sandboxProblem(install, route === "temporary" ? stageDir : installable);
      if (sandboxed) warn(sandboxed);
      let outcome: InstallOutcome;
      try {
        outcome =
          route === "temporary"
            ? await installTemporarily(plan.target, stageDir, addonId, staticRules, opts)
            : await installByPrompt(plan.target, route, installable, staticRules, opts);
      } catch (err) {
        fail((err as Error).message);
        outcome = "failed";
      }
      if (outcome === "installed") {
        result.profilePath = profile.path;
        // Temporary installs are gone at the next restart, so there's nothing to remember.
        if (route !== "temporary") {
          recordInstall({
            id: addonId,
            name: src.name,
            version: installVersion,
            profilePath: profile.path,
            route,
            installedAt: new Date().toISOString(),
          });
        }
      }
      // Firefox never lists temporary add-ons in extensions.json; the remote
      // install already confirmed that one.
      if (opts.verify && outcome !== "failed" && route !== "temporary") {
        info(`Waiting up to ${VERIFY_TIMEOUT_MS / 1000} s for ${addonId} ${installVersion} to be installed and enabled …`);
        if (await waitForAddon(profile.path, addonId, installVersion, VERIFY_TIMEOUT_MS)) {
          ok(`Verified: ${src.name} ${installVersion} is installed and enabled in ${profile.path}`);
        } else {
          fail(`--verify: ${addonId} ${installVersion} wasn't installed and enabled in ${profile.path} within ${VERIFY_TIMEOUT_MS / 1000} s.`);
          outcome = "failed";
        }
      }
      if (outcome === "failed") result.installFailed = true;
    }

    result.success = true;
    printIssues(issues);
    return result;
  } finally {
    scratch.dispose();
  }
}
