// Shared setup for the CLI tests: runs the built CLI in a child process with its
// per-user directories in a throwaway dir and no AMO credentials from the
// environment, so a developer's own keys never reach AMO from a test.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_PREFIX } from "../dist/name.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const CREDENTIAL_VARS = [`${ENV_PREFIX}_AMO_KEY`, `${ENV_PREFIX}_AMO_SECRET`, "WEB_EXT_API_KEY", "WEB_EXT_API_SECRET"];

/** A temp dir removed when the test ends. */
export function tempDir(t, prefix = "lavaduct-cli-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cliEnv({ state, home, env = {} }) {
  const base = { ...process.env, NO_COLOR: "1" };
  for (const name of CREDENTIAL_VARS) delete base[name];
  if (state) {
    base[`${ENV_PREFIX}_STATE_DIR`] = join(state, "state");
    base[`${ENV_PREFIX}_CACHE_DIR`] = join(state, "cache");
  }
  if (home) {
    Object.assign(base, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming") });
    delete base.XDG_CONFIG_HOME;
    delete base.MOZ_LEGACY_HOME;
  }
  return { ...base, ...env };
}

/**
 * Run the CLI. `state` holds the state and cache dirs; pass the same one to two
 * runs to share the add-on ID salt. With `home`, profile discovery reads that
 * directory instead of the real Firefox profiles.
 */
export function runCli(args, { cwd, ...opts } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf-8", env: cliEnv(opts) });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** runCli without blocking the event loop, for a test that serves pages to Firefox while the CLI runs. */
export async function runCliAsync(args, { cwd, ...opts } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: cliEnv(opts) });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf-8").on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

/** Write files into `dir`; objects are written as JSON. */
export function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/**
 * A small MV3 extension: a classic service worker that imports a library, a
 * side panel, a content script and two permissions Firefox handles differently.
 */
export function sampleExtension(overrides = {}) {
  return {
    "manifest.json": {
      manifest_version: 3,
      name: "Fixture Panel",
      version: "1.2.3",
      background: { service_worker: "sw.js" },
      permissions: ["storage", "sidePanel"],
      side_panel: { default_path: "panel.html" },
      action: { default_title: "Fixture" },
      content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js"] }],
    },
    "sw.js": 'importScripts("lib.js");\nchrome.runtime.onInstalled.addListener(() => self.lib);\n',
    "lib.js": "self.lib = 1;\n",
    "content.js": "chrome.runtime.sendMessage({ hello: 1 });\n",
    "panel.html": "<!doctype html>\n<html>\n<head><title>Panel</title></head>\n<body></body>\n</html>\n",
    ...overrides,
  };
}
