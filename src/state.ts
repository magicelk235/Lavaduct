import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NAME } from "./name.js";

// Per-user files live outside the working directory: the add-on ID salt, install
// records, AMO version history and pending submissions under the state dir; signed
// .xpi files under the cache dir. <NAME>_STATE_DIR / <NAME>_CACHE_DIR override them,
// which tests use to stay out of the real user directories.

const envKey = NAME.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export function stateDir(): string {
  const override = process.env[`${envKey}_STATE_DIR`];
  if (override) return override;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", NAME);
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), NAME);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), NAME);
}

export function cacheDir(): string {
  const override = process.env[`${envKey}_CACHE_DIR`];
  if (override) return override;
  if (process.platform === "linux") return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), NAME);
  return join(stateDir(), "cache");
}

/** Read a JSON file from the state dir; returns `fallback` when missing or unreadable. */
export function readState<T>(file: string, fallback: T): T {
  const path = join(stateDir(), file);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** Write a JSON file into the state dir atomically (temp file + rename). */
export function writeState(file: string, value: unknown): void {
  const path = join(stateDir(), file);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
