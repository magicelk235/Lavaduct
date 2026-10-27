import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { cpSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

const RESET = "\x1b[0m";
const COLORS = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
} as const;

// Diagnostics all go to stderr, so color follows stderr's TTY-ness.
const useColor = process.stderr.isTTY && !process.env.NO_COLOR;

export function color(c: keyof typeof COLORS, s: string): string {
  return useColor ? `${COLORS[c]}${s}${RESET}` : s;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let verbose = false;
/** Echo every subprocess invocation and its output. */
export function setVerbose(v: boolean): void {
  verbose = v;
}

let quiet = false;
/** Suppress progress chatter (info/ok); warnings and failures still print. */
export function setQuiet(v: boolean): void {
  quiet = v;
}

/** Run a command, capturing output. Never throws on a non-zero exit. */
export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  if (verbose) console.error(color("dim", `$ ${cmd} ${args.join(" ")}`));
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...opts,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { code: 127, stdout: "", stderr: `command not found: ${cmd}` };
  }
  const stdout = (res.stdout as string) ?? "";
  const stderr = (res.stderr as string) ?? "";
  if (verbose) {
    if (stdout.trim()) process.stdout.write(stdout);
    if (stderr.trim()) process.stderr.write(stderr);
  }
  return { code: res.status ?? 1, stdout, stderr };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a command name against PATH (and PATHEXT on Windows) without spawning
 * `which`/`where`, which differ per OS. Returns the absolute path or null.
 */
export function which(cmd: string): string | null {
  if (isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) return isFile(cmd) ? cmd : null;
  const exts =
    process.platform === "win32" && !extname(cmd)
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// Diagnostics go to stderr so stdout carries only real output, e.g. the
// --analyze --json payload.
export function info(msg: string): void {
  if (quiet) return;
  console.error(`${color("blue", "›")} ${msg}`);
}
export function ok(msg: string): void {
  if (quiet) return;
  console.error(`${color("green", "✓")} ${msg}`);
}
export function warn(msg: string): void {
  console.error(`${color("yellow", "!")} ${msg}`);
}
export function fail(msg: string): void {
  console.error(`${color("red", "✗")} ${msg}`);
}

/** Move a file or directory to `dest`, replacing it. Falls back to copy+delete across volumes. */
export function moveInto(src: string, dest: string): boolean {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  try {
    renameSync(src, dest);
  } catch {
    try {
      cpSync(src, dest, { recursive: true });
    } catch {
      return false;
    }
    rmSync(src, { recursive: true, force: true });
  }
  return existsSync(dest);
}
