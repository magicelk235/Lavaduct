import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { ENV_PREFIX } from "../name.js";
import { readState, stateDir, writeState } from "../state.js";
import { walkScripts } from "../input/stage.js";
import { deleteRegistryKey, readRegistryDefault, writeRegistryDefault } from "./platform/win32.js";

// A Chrome extension reaches a native app through the host manifest the app
// installed for Chrome. Firefox reads host manifests from its own places, and
// names the add-ons a host may serve in `allowed_extensions` (add-on IDs) where
// Chrome has `allowed_origins`. Registering a converted add-on means writing, or
// extending, the Firefox manifest of each host it talks to.
//
// Chrome starts a host with the caller's origin as its argument and Firefox with
// the manifest's path and the add-on ID, so a host that checks its caller may
// still refuse a Firefox add-on.

/** State file: the Firefox host manifests written or extended, so --uninstall can undo it. */
const RECORDS_FILE = "native-hosts.json";
/** Puts the Firefox manifests in this directory instead of the per-user one; tests use it. */
const DIR_OVERRIDE = `${ENV_PREFIX}_NATIVE_HOSTS_DIR`;
// Chrome's rule for host names: dot-separated runs of lowercase letters, digits and _.
const HOST_NAME_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
const NATIVE_CALL_RE = /\b(?:connectNative|sendNativeMessage)\b/;
const STRING_RE = /(["'`])([a-z0-9_.]+)\1/g;

export interface Registry {
  read(key: string): string | undefined;
  write(key: string, value: string): boolean;
  remove(key: string): boolean;
}

/** Where host manifests live on one machine. */
export interface HostSystem {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  registry: Registry;
  /** Folder for the Firefox manifests on Windows, which the registry points at. */
  manifestStore: string;
}

export function hostSystem(over: Partial<HostSystem> = {}): HostSystem {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    registry: { read: readRegistryDefault, write: writeRegistryDefault, remove: deleteRegistryKey },
    manifestStore: join(stateDir(), "native-messaging-hosts"),
    ...over,
  };
}

/** Folders Chromium-based browsers read host manifests from, per user first. Not Windows: it uses the registry. */
export function chromeHostDirs(sys: Pick<HostSystem, "platform" | "home" | "env">): string[] {
  if (sys.platform === "darwin") {
    const support = join(sys.home, "Library", "Application Support");
    const user = [
      "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary", "Chromium",
      "BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser-Beta", "BraveSoftware/Brave-Browser-Nightly",
      "Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev", "Microsoft Edge Canary", "Vivaldi", "Arc/User Data",
    ].map((b) => join(support, ...b.split("/"), "NativeMessagingHosts"));
    return [
      ...user,
      "/Library/Google/Chrome/NativeMessagingHosts",
      "/Library/Application Support/Chromium/NativeMessagingHosts",
      "/Library/Microsoft/Edge/NativeMessagingHosts",
    ];
  }
  if (sys.platform === "win32") return [];
  const config = sys.env.XDG_CONFIG_HOME || join(sys.home, ".config");
  const user = [
    "google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "BraveSoftware/Brave-Browser",
    "microsoft-edge", "microsoft-edge-beta", "microsoft-edge-dev", "vivaldi",
  ].map((b) => join(config, ...b.split("/"), "NativeMessagingHosts"));
  return [...user, "/etc/opt/chrome/native-messaging-hosts", "/etc/chromium/native-messaging-hosts", "/etc/opt/edge/native-messaging-hosts"];
}

/** Registry keys whose default value names a Chromium browser's host manifest on Windows, per user first. */
export function chromeHostKeys(name: string): string[] {
  const brands = ["Google\\Chrome", "Chromium", "Microsoft\\Edge", "BraveSoftware\\Brave-Browser"];
  return ["HKCU", "HKLM"].flatMap((hive) => brands.map((b) => `${hive}\\Software\\${b}\\NativeMessagingHosts\\${name}`));
}

/** The per-user folder Firefox reads host manifests from (macOS, Linux). */
export function firefoxHostDir(sys: Pick<HostSystem, "platform" | "home" | "env">): string {
  const override = sys.env[DIR_OVERRIDE];
  if (override) return override;
  if (sys.platform === "darwin") return join(sys.home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts");
  return join(sys.home, ".mozilla", "native-messaging-hosts");
}

/** Machine-wide folders Firefox reads after the per-user one (macOS, Linux). */
function firefoxSystemDirs(sys: HostSystem): string[] {
  if (sys.env[DIR_OVERRIDE]) return [];
  if (sys.platform === "darwin") return ["/Library/Application Support/Mozilla/NativeMessagingHosts"];
  return ["/usr/lib/mozilla/native-messaging-hosts", "/usr/lib64/mozilla/native-messaging-hosts"];
}

/** Registry key whose default value names Firefox's host manifest on Windows. */
export function firefoxHostKey(name: string, hive: "HKCU" | "HKLM" = "HKCU"): string {
  return `${hive}\\Software\\Mozilla\\NativeMessagingHosts\\${name}`;
}

/** Native host names the add-on's code names in the files that call connectNative or sendNativeMessage. */
export function nativeHostNames(dir: string): string[] {
  const names = new Set<string>();
  for (const file of walkScripts(dir)) {
    let src: string;
    try { src = readFileSync(file, "utf-8"); } catch { continue; }
    if (!NATIVE_CALL_RE.test(src)) continue;
    for (const m of src.matchAll(STRING_RE)) if (HOST_NAME_RE.test(m[2])) names.add(m[2]);
  }
  return [...names].sort();
}

interface HostManifest {
  name?: string;
  description?: string;
  path?: string;
  type?: string;
  allowed_origins?: unknown;
  allowed_extensions?: unknown;
}

function readManifest(file: string): HostManifest | undefined {
  try {
    const m: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return m && typeof m === "object" && !Array.isArray(m) ? (m as HostManifest) : undefined;
  } catch {
    return undefined;
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/** The Chrome host manifest for `name`, preferring one that lets this extension in. */
function chromeHost(name: string, sys: HostSystem, origin: string): { file: string; manifest: HostManifest } | undefined {
  const files =
    sys.platform === "win32"
      ? chromeHostKeys(name).map((k) => sys.registry.read(k)).filter((f): f is string => !!f)
      : chromeHostDirs(sys).map((d) => join(d, `${name}.json`));
  let first: { file: string; manifest: HostManifest } | undefined;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const manifest = readManifest(file);
    if (!manifest) continue;
    if (origin && strings(manifest.allowed_origins).includes(origin)) return { file, manifest };
    first ??= { file, manifest };
  }
  return first;
}

/** The Firefox manifest Firefox would read for `name` today, and whether it is the per-user one. */
function firefoxHost(name: string, sys: HostSystem): { file: string; user: boolean } | undefined {
  if (sys.platform === "win32") {
    const user = sys.registry.read(firefoxHostKey(name, "HKCU"));
    if (user && existsSync(user)) return { file: user, user: true };
    const machine = sys.env[DIR_OVERRIDE] ? undefined : sys.registry.read(firefoxHostKey(name, "HKLM"));
    return machine && existsSync(machine) ? { file: machine, user: false } : undefined;
  }
  const userFile = join(firefoxHostDir(sys), `${name}.json`);
  if (existsSync(userFile)) return { file: userFile, user: true };
  for (const d of firefoxSystemDirs(sys)) {
    const file = join(d, `${name}.json`);
    if (existsSync(file)) return { file, user: false };
  }
  return undefined;
}

interface HostRecord {
  name: string;
  addonId: string;
  file: string;
  /** The manifest didn't exist before, so it goes when its last add-on does. */
  created: boolean;
  registryKey?: string;
}

function remember(rec: HostRecord): void {
  const records = readState<HostRecord[]>(RECORDS_FILE, []).filter((r) => !(r.name === rec.name && r.addonId === rec.addonId));
  writeState(RECORDS_FILE, [...records, rec]);
}

export interface HostResult {
  name: string;
  outcome: "created" | "added" | "present" | "skipped";
  /** The Firefox manifest written, or the one left as it was. */
  file?: string;
  detail: string;
}

/**
 * Register the add-on with the native apps its code talks to. For each host name
 * the code uses, the host's Chrome manifest must allow the extension's Chrome ID
 * (so an add-on never reaches an app that didn't let the original extension in),
 * and the program it names must exist. The add-on ID then goes into the Firefox
 * manifest Firefox reads for that host: an existing per-user one is extended,
 * never overwritten; a machine-wide one is copied into a per-user one, which
 * Firefox reads first, so the add-ons it lists keep their access; with neither, a
 * new one names the Chrome manifest's program. Chrome's manifests are not touched.
 */
export function registerNativeHosts(
  opts: { dir: string; addonId: string; chromeId?: string },
  sys: HostSystem = hostSystem(),
): HostResult[] {
  const results: HostResult[] = [];
  const origin = opts.chromeId ? `chrome-extension://${opts.chromeId}/` : "";
  for (const name of nativeHostNames(opts.dir)) {
    const chrome = chromeHost(name, sys, origin);
    if (!chrome) continue;
    const skip = (detail: string) => results.push({ name, outcome: "skipped", detail });
    if (!origin) {
      skip(`this extension has no Chrome ID to match against ${chrome.file}`);
      continue;
    }
    if (!strings(chrome.manifest.allowed_origins).includes(origin)) {
      skip(`${chrome.file} doesn't allow ${origin}`);
      continue;
    }
    const raw = typeof chrome.manifest.path === "string" ? chrome.manifest.path : "";
    const program = raw && (isAbsolute(raw) ? raw : resolve(dirname(chrome.file), raw));
    let present = false;
    try { present = !!program && statSync(program).isFile(); } catch {}
    if (!present) {
      skip(`the app's host program${program ? ` (${program})` : ""} isn't there`);
      continue;
    }

    const existing = firefoxHost(name, sys);
    if (existing?.user) {
      const manifest = readManifest(existing.file);
      if (!manifest) {
        skip(`${existing.file} isn't a valid host manifest; left as it is`);
        continue;
      }
      const allowed = strings(manifest.allowed_extensions);
      if (allowed.includes(opts.addonId)) {
        results.push({ name, outcome: "present", file: existing.file, detail: `${existing.file} already lists the add-on` });
        continue;
      }
      try {
        writeJson(existing.file, { ...manifest, allowed_extensions: [...allowed, opts.addonId] });
      } catch (e) {
        skip(`${existing.file} can't be written: ${(e as Error).message}`);
        continue;
      }
      remember({ name, addonId: opts.addonId, file: existing.file, created: false });
      results.push({ name, outcome: "added", file: existing.file, detail: `added the add-on to ${existing.file}` });
      continue;
    }

    // A machine-wide Firefox manifest belongs to the app: the copy keeps the
    // program and the add-ons it names. Windows Firefox resolves a relative
    // program path against the manifest's folder, which the copy leaves.
    const base = existing ? readManifest(existing.file) : undefined;
    const source = base ?? chrome.manifest;
    const basePath = base && typeof base.path === "string" ? base.path : undefined;
    const manifest = {
      name,
      description: typeof source.description === "string" ? source.description : name,
      path:
        existing && basePath !== undefined
          ? sys.platform === "win32" && !win32.isAbsolute(basePath)
            ? win32.join(win32.dirname(existing.file), basePath)
            : basePath
          : program,
      type: "stdio",
      allowed_extensions: [...(base ? strings(base.allowed_extensions) : []), opts.addonId],
    };
    const file = join(sys.platform === "win32" && !sys.env[DIR_OVERRIDE] ? sys.manifestStore : firefoxHostDir(sys), `${name}.json`);
    try {
      writeJson(file, manifest);
    } catch (e) {
      skip(`${file} can't be written: ${(e as Error).message}`);
      continue;
    }
    let registryKey: string | undefined;
    if (sys.platform === "win32") {
      registryKey = firefoxHostKey(name);
      if (!sys.registry.write(registryKey, file)) {
        rmSync(file, { force: true });
        skip(`the registry key ${registryKey} can't be written`);
        continue;
      }
    }
    remember({ name, addonId: opts.addonId, file, created: true, ...(registryKey ? { registryKey } : {}) });
    results.push({
      name,
      outcome: "created",
      file,
      detail: existing ? `wrote ${file} from ${existing.file}, keeping the add-ons it lists` : `wrote ${file} for ${program}`,
    });
  }
  return results;
}

/** Take the add-on out of the Firefox host manifests registerNativeHosts put it in. Returns what changed. */
export function unregisterNativeHosts(addonId: string, sys: HostSystem = hostSystem()): Array<{ ok: boolean; detail: string }> {
  const records = readState<HostRecord[]>(RECORDS_FILE, []);
  const notes: Array<{ ok: boolean; detail: string }> = [];
  for (const rec of records.filter((r) => r.addonId === addonId)) {
    const manifest = readManifest(rec.file);
    if (!manifest) continue;
    const allowed = strings(manifest.allowed_extensions).filter((id) => id !== addonId);
    // The registry key names the file only while it is still ours.
    const keyIsOurs = rec.registryKey !== undefined && sys.registry.read(rec.registryKey) === rec.file;
    try {
      if (rec.created && allowed.length === 0) {
        rmSync(rec.file, { force: true });
        if (keyIsOurs && rec.registryKey) sys.registry.remove(rec.registryKey);
        notes.push({ ok: true, detail: `removed the native host manifest ${rec.file}` });
      } else {
        writeJson(rec.file, { ...manifest, allowed_extensions: allowed });
        notes.push({ ok: true, detail: `took the add-on out of ${rec.file}` });
      }
    } catch (e) {
      notes.push({ ok: false, detail: `${rec.file} can't be written: ${(e as Error).message}` });
    }
  }
  const kept = records.filter((r) => r.addonId !== addonId);
  // A manifest written for this add-on that other add-ons still use passes to
  // one of them, so the last to go removes it (and its registry key).
  for (const rec of records) {
    if (rec.addonId !== addonId || !rec.created) continue;
    const heir = kept.find((r) => r.file === rec.file);
    if (!heir) continue;
    heir.created = true;
    if (rec.registryKey !== undefined) heir.registryKey = rec.registryKey;
  }
  writeState(RECORDS_FILE, kept);
  return notes;
}
