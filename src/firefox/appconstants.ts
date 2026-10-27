import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readZipEntry } from "../zip/read.js";

export interface AppConstants {
  /** MOZ_REQUIRE_SIGNING: when true, xpinstall.signatures.required=false is ignored. */
  requireSigning: boolean;
  /** MOZ_UPDATE_CHANNEL: release, beta, aurora (Developer Edition), nightly, esr or default. */
  channel: string;
  /** MOZ_APP_VERSION, e.g. "159.0", "153.6.0" or "161.0a1". */
  version: string;
}

/**
 * Read the build constants that decide which signing routes an install allows.
 * They live in modules/AppConstants.sys.mjs inside the GRE omni.ja, which sits
 * next to the binary on Windows and Linux and in Contents/Resources on macOS.
 * The channel can't be taken from defaults/pref/channel-prefs.js because macOS
 * builds don't ship that file. Returns null when the directory doesn't look
 * like a Firefox install.
 */
export function readAppConstants(installDir: string): AppConstants | null {
  const omni = [join(installDir, "omni.ja"), join(installDir, "..", "Resources", "omni.ja")].find((p) =>
    existsSync(p),
  );
  if (!omni) return null;
  let source: Buffer | null;
  try {
    source = readZipEntry(readFileSync(omni), "modules/AppConstants.sys.mjs");
  } catch {
    return null;
  }
  return source ? parseAppConstants(source.toString("utf-8")) : null;
}

/** Pull the three constants out of AppConstants.sys.mjs source text. */
export function parseAppConstants(source: string): AppConstants | null {
  // The preprocessor can leave `//@line` comments between a key and its value.
  const value = (key: string): string | undefined =>
    new RegExp(`\\b${key}:\\s*(?:\\/\\/[^\\n]*\\n\\s*)*(true|false|"[^"\\n]*")`).exec(source)?.[1];
  const signing = value("MOZ_REQUIRE_SIGNING");
  const channel = value("MOZ_UPDATE_CHANNEL");
  const version = value("MOZ_APP_VERSION");
  if ((signing !== "true" && signing !== "false") || !channel?.startsWith('"') || !version?.startsWith('"')) {
    return null;
  }
  return {
    requireSigning: signing === "true",
    channel: channel.slice(1, -1),
    version: version.slice(1, -1),
  };
}
