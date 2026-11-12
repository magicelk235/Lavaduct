import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 as path } from "node:path";
import { run } from "../../util.js";
import type { LockHolder, Platform, ProfileLookup } from "./index.js";
import { pathKey } from "./shared.js";

// Brand keys the Mozilla installer writes under SOFTWARE\Mozilla: release, beta
// and ESR share the first; unofficial builds use the last.
const BRANDS = ["Mozilla Firefox", "Firefox Developer Edition", "Nightly", "Mozilla Developer Preview"];

// Default install folders, for copies whose registry keys are missing.
const FOLDERS = ["Mozilla Firefox", "Firefox Developer Edition", "Firefox Nightly"];

/**
 * Firefox binaries named in `reg query HKxx\SOFTWARE\Mozilla /s /v PathToExe`
 * output. Keys look like `…\Mozilla\Mozilla Firefox\159.0 (x64 en-US)\Main`
 * or `…\Mozilla\Mozilla Firefox 153.6.0 ESR\bin`; other Mozilla products
 * (Thunderbird) share the tree and are skipped.
 */
export function firefoxExesFromReg(output: string): string[] {
  const exes: string[] = [];
  let brandKey = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("HKEY_")) {
      const product = /\\SOFTWARE\\(?:WOW6432Node\\)?Mozilla\\([^\\]+)/i.exec(line)?.[1] ?? "";
      brandKey = BRANDS.some((b) => product === b || product.startsWith(`${b} `));
      continue;
    }
    const value = /^\s+PathToExe\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line)?.[1];
    if (brandKey && value && /(^|\\)firefox\.exe$/i.test(value)) exes.push(value);
  }
  return exes;
}

/**
 * The default value in `reg query <key> /ve` output. The value's label is
 * localized ("(Default)", "(Standard)", …), so the first REG_SZ row counts; a key
 * whose default isn't set shows a parenthesized note instead of a value.
 */
export function registryDefaultFromReg(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const value = /^\s+\S.*?\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/i.exec(line)?.[1];
    if (value !== undefined) return value && !/^\(.*\)$/.test(value) ? value : undefined;
  }
  return undefined;
}

/** A registry key's default value. Machine-wide keys are read in both registry views. */
export function readRegistryDefault(key: string): string | undefined {
  const views = /^(?:HKLM|HKEY_LOCAL_MACHINE)\\/i.test(key) ? ["/reg:64", "/reg:32"] : [undefined];
  for (const view of views) {
    const res = run("reg", ["query", key, "/ve", ...(view ? [view] : [])]);
    const value = res.code === 0 ? registryDefaultFromReg(res.stdout) : undefined;
    if (value !== undefined) return value.replace(/%([^%]+)%/g, (all, name: string) => process.env[name] ?? all);
  }
  return undefined;
}

/** Create the key if needed and set its default value. */
export function writeRegistryDefault(key: string, value: string): boolean {
  return run("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"]).code === 0;
}

export function deleteRegistryKey(key: string): boolean {
  return run("reg", ["delete", key, "/f"]).code === 0;
}

export interface WinProcess {
  pid: number;
  parentPid?: number;
  exe?: string;
  commandLine?: string;
}

/**
 * Rows of `Get-CimInstance Win32_Process | Select-Object ProcessId,
 * ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json`: one object
 * for a single process, an array for several, nothing for none.
 */
export function parseProcessJson(text: string): WinProcess[] {
  let data: unknown;
  try {
    data = JSON.parse(text.trim() || "[]");
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(data) ? data : [data];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object" || !("ProcessId" in row) || typeof row.ProcessId !== "number") return [];
    const parentPid =
      "ParentProcessId" in row && typeof row.ParentProcessId === "number" ? row.ParentProcessId : undefined;
    const exe = "ExecutablePath" in row && typeof row.ExecutablePath === "string" ? row.ExecutablePath : undefined;
    const commandLine = "CommandLine" in row && typeof row.CommandLine === "string" ? row.CommandLine : undefined;
    return [{ pid: row.ProcessId, parentPid, exe, commandLine }];
  });
}

/** Split a Windows command line the way CommandLineToArgvW does. */
export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let i = 0;
  const n = commandLine.length;
  while (i < n && /\s/.test(commandLine[i])) i++;

  // The program name ends at the closing quote or the first space; backslashes are literal.
  if (i < n) {
    let program = "";
    if (commandLine[i] === '"') {
      i++;
      while (i < n && commandLine[i] !== '"') program += commandLine[i++];
      i++;
    } else {
      while (i < n && !/\s/.test(commandLine[i])) program += commandLine[i++];
    }
    args.push(program);
  }

  while (i < n) {
    while (i < n && /\s/.test(commandLine[i])) i++;
    if (i >= n) break;
    let arg = "";
    let quoted = false;
    while (i < n && (quoted || !/\s/.test(commandLine[i]))) {
      if (commandLine[i] === "\\") {
        let slashes = 0;
        while (commandLine[i] === "\\") {
          slashes++;
          i++;
        }
        if (commandLine[i] === '"') {
          // 2n backslashes + quote: n backslashes, then the quote toggles.
          // 2n+1 backslashes + quote: n backslashes and a literal quote.
          arg += "\\".repeat(slashes >> 1);
          if (slashes % 2 === 1) {
            arg += '"';
            i++;
          }
        } else {
          arg += "\\".repeat(slashes);
        }
      } else if (commandLine[i] === '"') {
        quoted = !quoted;
        i++;
      } else {
        arg += commandLine[i++];
      }
    }
    args.push(arg);
  }
  return args;
}

/**
 * The profile a Firefox command line asks for, read the way Firefox reads
 * flags on Windows: case-insensitive, starting with `-`, `--` or `/`, with the
 * value either after `=` or as the next argument, which must not look like a
 * flag itself. `--profile` wins over `-P`, and a `-P` without a name opens the
 * Profile Manager instead.
 */
export function profileFromArgs(args: string[]): { name?: string; path?: string } | undefined {
  const valueOf = (flag: string): string | undefined => {
    for (let i = 0; i < args.length; i++) {
      const match = /^(?:--?|\/)([^=]*)(?:=(.*))?$/s.exec(args[i]);
      if (!match || match[1].toLowerCase() !== flag) continue;
      if (match[2] !== undefined) return match[2];
      const next = args[i + 1];
      return next === undefined || /^[-/]/.test(next) ? undefined : next;
    }
    return undefined;
  };
  const path = valueOf("profile");
  if (path) return { path };
  const name = valueOf("p");
  return name ? { name } : undefined;
}

/**
 * The browser process using a profile, among running firefox.exe processes.
 * Content, GPU and other child processes carry `-contentproc`; background
 * tasks run on throwaway profiles. A main process started without a profile
 * flag runs its install's default profile. When the launcher process stays
 * around (it waits for the browser under --remote-debugging-port or
 * --headless), it has the same command line as the browser it started, so the
 * child is the one to pick.
 */
export function pickLockHolder(
  processes: WinProcess[],
  profilePath: string,
  lookup: ProfileLookup,
): LockHolder | undefined {
  const target = pathKey(profilePath);
  const holders = processes.filter((proc) => {
    if (!proc.commandLine) return false;
    const args = splitCommandLine(proc.commandLine).slice(1);
    if (args.some((a) => /^(?:--?|\/)(?:contentproc|backgroundtask)$/i.test(a))) return false;
    const wanted = profileFromArgs(args);
    const dir =
      wanted?.path ??
      (wanted?.name !== undefined
        ? lookup.pathForName(wanted.name)
        : proc.exe
          ? lookup.defaultForBinary(proc.exe)
          : undefined);
    return dir !== undefined && pathKey(dir) === target;
  });
  const launchers = new Set(holders.map((proc) => proc.parentPid));
  const browser = holders.find((proc) => !launchers.has(proc.pid)) ?? holders[0];
  return browser && { pid: browser.pid, exe: browser.exe };
}

/** Run a PowerShell script; its stdout, or undefined when it failed. */
function powershell(script: string): string | undefined {
  const res = run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
  return res.code === 0 ? res.stdout : undefined;
}

function listFirefoxProcesses(): WinProcess[] {
  const out = powershell(
    "Get-CimInstance -ClassName Win32_Process -Filter \"Name = 'firefox.exe'\" | " +
      "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  );
  return out === undefined ? [] : parseProcessJson(out);
}

export const win32: Platform = {
  installCandidates() {
    // Both hives (per-machine and per-user installs) and both registry views
    // (64- and 32-bit builds). Keys outlive uninstalled copies, so each
    // PathToExe must still exist.
    const exes: string[] = [];
    for (const hive of ["HKLM", "HKCU"]) {
      for (const view of ["/reg:64", "/reg:32"]) {
        const res = run("reg", ["query", `${hive}\\SOFTWARE\\Mozilla`, "/s", "/v", "PathToExe", view]);
        if (res.code === 0) exes.push(...firefoxExesFromReg(res.stdout));
      }
    }
    const env = process.env;
    for (const base of [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
      if (base) exes.push(...FOLDERS.map((f) => path.join(base, f, "firefox.exe")));
    }
    return exes.filter((exe) => existsSync(exe)).map((exe) => ({ binary: exe, installDir: path.dirname(exe) }));
  },

  candidateFromPath(p) {
    const exe = statSync(p, { throwIfNoEntry: false })?.isDirectory() ? path.join(p, "firefox.exe") : p;
    return existsSync(exe) ? { binary: exe, installDir: path.dirname(exe) } : undefined;
  },

  profileRoots() {
    return [path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "Mozilla", "Firefox")];
  },

  profileSetup(install) {
    return { roots: this.profileRoots(), hashDir: install.installDir, legacy: false };
  },

  profileLocked(profilePath) {
    // Firefox keeps parent.lock open without sharing for as long as it runs and
    // never deletes it, so the file existing says nothing; opening it does.
    let fd: number;
    try {
      fd = openSync(path.join(profilePath, "parent.lock"), "r");
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EBUSY";
    }
    closeSync(fd);
    return false;
  },

  lockHolder(profilePath, lookup) {
    return pickLockHolder(listFirefoxProcesses(), profilePath, lookup);
  },

  requestQuit(pid) {
    // Without /F, taskkill posts WM_CLOSE to the process's windows, the same
    // as closing them by hand.
    return run("taskkill", ["/PID", String(pid)]).code === 0;
  },

  quitMinAgeMs: 0,

  processAgeMs(pid) {
    // CreationDate is a local DateTime; "o" prints it with its UTC offset.
    const out = powershell(
      `(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${Math.trunc(pid)}").CreationDate.ToString("o")`,
    );
    const started = out === undefined ? NaN : Date.parse(out.trim());
    return Number.isFinite(started) ? Math.max(0, Date.now() - started) : undefined;
  },

  visibleLaunchArgs() {
    return [];
  },
};
