import { readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "../../util.js";

/** The canonical spelling of a path (symlinks resolved, true case), or the path itself when it isn't on disk. */
export function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** A key that compares equal for two spellings of the same path. */
export function pathKey(path: string): string {
  const p = realPath(resolve(path));
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * PID behind a symlink lock (`lock` on Linux, `.parentlock` on macOS when the
 * filesystem can't do fcntl locks), whose target reads `<ip>:<pid>` or
 * `<ip>:+<pid>`. Undefined when there is no such lock or its process is gone.
 */
export function symlinkLockHolder(lockPath: string): number | undefined {
  let target: string;
  try {
    target = readlinkSync(lockPath);
  } catch {
    return undefined;
  }
  const match = /:\+?(\d+)$/.exec(target);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return processAlive(pid) ? pid : undefined;
}

/** Whether a process exists, including one owned by another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * How long a process has been running, from `ps -o etime=` (`[[dd-]hh:]mm:ss`).
 * Undefined when ps can't say, e.g. the process is gone.
 */
export function processAgeMs(pid: number): number | undefined {
  const etime = run("ps", ["-o", "etime=", "-p", String(pid)]).stdout.trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!match) return undefined;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}
