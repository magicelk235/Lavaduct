import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-user state (the record of what was registered) stays in a temp dir.
const state = mkdtempSync(join(tmpdir(), "lavaduct-nm-state-"));
process.env.LAVADUCT_STATE_DIR = state;
const { chromeHostDirs, firefoxHostDir, hostSystem, nativeHostNames, registerNativeHosts, unregisterNativeHosts } = await import(
  "../dist/firefox/native-hosts.js"
);

// A converted extension reaches its native app only once Firefox has a host
// manifest naming the add-on, written from the one the app installed for Chrome.

const CHROME_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
const ADDON = `${CHROME_ID}.0123abcd@lavaduct`;
const HOST = "com.lavaduct_test.native_app";

function fixture(t, { platform = "darwin", allowed = [`chrome-extension://${CHROME_ID}/`], env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lavaduct-nm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const program = join(root, "app", "native-host");
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(program, "#!/bin/sh\n");
  const ext = join(root, "ext");
  mkdirSync(ext);
  writeFileSync(join(ext, "sw.js"), `const hosts = [{ name: "${HOST}" }, { name: "main.js" }];\nfor (const h of hosts) chrome.runtime.connectNative(h.name);`);
  const chromeManifest = { name: HOST, description: "Native app", path: program, type: "stdio", allowed_origins: allowed };
  const registry = new Map();
  const sys = hostSystem({
    platform,
    home,
    env,
    manifestStore: join(root, "store"),
    registry: { read: (k) => registry.get(k), write: (k, v) => (registry.set(k, v), true), remove: (k) => registry.delete(k) },
  });
  let chromeFile;
  if (platform === "win32") {
    chromeFile = join(root, "chrome-host.json");
    registry.set(`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`, chromeFile);
  } else {
    chromeFile = join(chromeHostDirs(sys)[0], `${HOST}.json`);
    mkdirSync(join(chromeFile, ".."), { recursive: true });
  }
  writeFileSync(chromeFile, JSON.stringify(chromeManifest, null, 2));
  return { root, home, ext, program, sys, registry, chromeFile, chromeText: readFileSync(chromeFile, "utf-8") };
}

const read = (file) => JSON.parse(readFileSync(file, "utf-8"));

test("only names in code that talks to native apps are candidates", (t) => {
  const { ext } = fixture(t);
  writeFileSync(join(ext, "other.js"), 'const config = "com.example.not_native";');
  assert.deepEqual(nativeHostNames(ext), [HOST, "main.js"].sort());
});

test("macOS: the Firefox manifest names the Chrome manifest's program and the add-on, and Chrome's is untouched", (t) => {
  const f = fixture(t);
  const results = registerNativeHosts({ dir: f.ext, addonId: ADDON, chromeId: CHROME_ID }, f.sys);
  const file = join(f.home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts", `${HOST}.json`);
  assert.deepEqual(results.map((r) => [r.name, r.outcome, r.file]), [[HOST, "created", file]]);
  assert.deepEqual(read(file), { name: HOST, description: "Native app", path: f.program, type: "stdio", allowed_extensions: [ADDON] });
  assert.equal(readFileSync(f.chromeFile, "utf-8"), f.chromeText);

  assert.equal(registerNativeHosts({ dir: f.ext, addonId: ADDON, chromeId: CHROME_ID }, f.sys)[0].outcome, "present", "a second run changes nothing");
  unregisterNativeHosts(ADDON, f.sys);
  assert.equal(existsSync(file), false, "a manifest written for the add-on goes with it");
});

test("a Firefox manifest that lists other add-ons is extended, and given back as it was", (t) => {
  const f = fixture(t);
  const file = join(firefoxHostDir(f.sys), `${HOST}.json`);
  mkdirSync(firefoxHostDir(f.sys), { recursive: true });
  const theirs = { name: HOST, description: "Vendor build", path: "/opt/vendor/host", type: "stdio", allowed_extensions: ["vendor@example.com"] };
  writeFileSync(file, JSON.stringify(theirs));
  const [r] = registerNativeHosts({ dir: f.ext, addonId: ADDON, chromeId: CHROME_ID }, f.sys);
  assert.equal(r.outcome, "added");
  assert.deepEqual(read(file), { ...theirs, allowed_extensions: ["vendor@example.com", ADDON] }, "its program and add-ons stay");
  unregisterNativeHosts(ADDON, f.sys);
  assert.deepEqual(read(file), theirs);
});

test("an app whose Chrome manifest doesn't let the extension in is not registered", (t) => {
  const f = fixture(t, { allowed: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] });
  const [r] = registerNativeHosts({ dir: f.ext, addonId: ADDON, chromeId: CHROME_ID }, f.sys);
  assert.equal(r.outcome, "skipped");
  assert.match(r.detail, /doesn't allow chrome-extension:\/\/fcoeo/);
  assert.equal(existsSync(join(firefoxHostDir(f.sys), `${HOST}.json`)), false);
  // An unpacked extension has no Chrome ID to check against.
  assert.equal(registerNativeHosts({ dir: f.ext, addonId: ADDON }, f.sys)[0].outcome, "skipped");
});

test("Linux: Chrome's manifests come from the XDG config dir, Firefox's go to ~/.mozilla", (t) => {
  const xdg = mkdtempSync(join(tmpdir(), "lavaduct-nm-xdg-"));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  const f = fixture(t, { platform: "linux", env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(chromeHostDirs(f.sys)[0], join(xdg, "google-chrome", "NativeMessagingHosts"));
  assert.ok(chromeHostDirs(f.sys).includes("/etc/opt/chrome/native-messaging-hosts"));
  const [r] = registerNativeHosts({ dir: f.ext, addonId: ADDON, chromeId: CHROME_ID }, f.sys);
  assert.equal(r.file, join(f.home, ".mozilla", "native-messaging-hosts", `${HOST}.json`));
  assert.deepEqual(read(r.file).allowed_extensions, [ADDON]);
});

test("Windows: the manifest is found and registered through the registry, keeping a machine-wide one's add-ons", (t) => {
  const f = fixture(t, { platform: "win32" });
  // The app also installed a Firefox manifest for every user, for its own add-on.
  const machine = join(f.root, "machine-host.json");
  writeFileSync(machine, JSON.stringify({ name: HOST, description: "Vendor", path: "C:\\Vendor\\host.exe", type: "stdio", allowed_extensions: ["vendor@example.com"] }));
  f.registry.set(`HKLM\\Software\\Mozilla\\NativeMessagingHosts\\${HOST}`, machine);

  const [r] = registerNativeHosts({ dir: f.ext, addonId: ADDON, chromeId: CHROME_ID }, f.sys);
  const userKey = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST}`;
  assert.equal(r.outcome, "created");
  assert.equal(f.registry.get(userKey), join(f.root, "store", `${HOST}.json`));
  // Firefox reads the per-user key first, so the copy keeps the vendor's add-on.
  assert.deepEqual(read(r.file), { name: HOST, description: "Vendor", path: "C:\\Vendor\\host.exe", type: "stdio", allowed_extensions: ["vendor@example.com", ADDON] });

  unregisterNativeHosts(ADDON, f.sys);
  assert.deepEqual(read(r.file).allowed_extensions, ["vendor@example.com"], "the copy still serves the vendor's add-on");
  assert.equal(f.registry.get(userKey), r.file);
});
