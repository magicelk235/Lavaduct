import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

const state = mkdtempSync(join(tmpdir(), "lavaduct-nm-rel-state-"));
process.env.LAVADUCT_STATE_DIR = state;
const { hostSystem, registerNativeHosts } = await import("../dist/firefox/native-hosts.js");

// On Windows, Firefox resolves a host manifest's relative `path` against the
// manifest's own folder. The per-user copy of a machine-wide manifest lives in
// another folder and wins over the original, so a relative path copied as it
// is points at nothing: the app's host breaks for every add-on, the vendor's
// own included.

const CHROME_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
const ADDON = `${CHROME_ID}.0123abcd@lavaduct`;
const HOST = "com.lavaduct_test.native_app";

test("a machine-wide Firefox manifest's relative program path still names the program in the per-user copy", (t) => {
  const root = mkdtempSync(join(tmpdir(), "lavaduct-nm-rel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vendor = join(root, "vendor");
  mkdirSync(vendor);
  const program = join(vendor, "host.exe");
  writeFileSync(program, "");
  const ext = join(root, "ext");
  mkdirSync(ext);
  writeFileSync(join(ext, "sw.js"), `chrome.runtime.connectNative("${HOST}");`);

  const chromeFile = join(vendor, "chrome-host.json");
  writeFileSync(chromeFile, JSON.stringify({ name: HOST, path: "host.exe", type: "stdio", allowed_origins: [`chrome-extension://${CHROME_ID}/`] }));
  const machineFile = join(vendor, "firefox-host.json");
  writeFileSync(machineFile, JSON.stringify({ name: HOST, description: "Vendor", path: "host.exe", type: "stdio", allowed_extensions: ["vendor@example.com"] }));
  const registry = new Map([
    [`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`, chromeFile],
    [`HKLM\\Software\\Mozilla\\NativeMessagingHosts\\${HOST}`, machineFile],
  ]);
  const sys = hostSystem({
    platform: "win32",
    home: join(root, "home"),
    env: {},
    manifestStore: join(root, "store"),
    registry: { read: (k) => registry.get(k), write: (k, v) => (registry.set(k, v), true), remove: (k) => registry.delete(k) },
  });

  const [r] = registerNativeHosts({ dir: ext, addonId: ADDON, chromeId: CHROME_ID }, sys);
  assert.equal(r.outcome, "created");
  assert.equal(r.file, join(root, "store", `${HOST}.json`));
  const copy = JSON.parse(readFileSync(r.file, "utf-8"));
  // Firefox swaps / for \ and joins the path onto the manifest's folder.
  assert.equal(copy.path, win32.join(vendor, "host.exe"));
  assert.deepEqual(copy.allowed_extensions, ["vendor@example.com", ADDON]);
});
