import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = mkdtempSync(join(tmpdir(), "lavaduct-nm-shared-state-"));
process.env.LAVADUCT_STATE_DIR = state;
const { chromeHostDirs, hostSystem, registerNativeHosts, unregisterNativeHosts } = await import("../dist/firefox/native-hosts.js");

// Two converted add-ons that talk to the same native app share the Firefox
// host manifest the first one created. Whichever goes last takes the manifest
// with it, instead of leaving a file that lists no add-on (Firefox rejects an
// empty allowed_extensions) and, on Windows, a registry key pointing at it.

const CHROME_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
const FIRST = `${CHROME_ID}.0123abcd@lavaduct`;
const SECOND = `${CHROME_ID}.4567cdef@lavaduct`;
const HOST = "com.lavaduct_test.native_app";

function fixture(t, platform) {
  const root = mkdtempSync(join(tmpdir(), "lavaduct-nm-shared-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const program = join(root, "native-host");
  writeFileSync(program, "#!/bin/sh\n");
  const ext = join(root, "ext");
  mkdirSync(ext);
  writeFileSync(join(ext, "sw.js"), `chrome.runtime.connectNative("${HOST}");`);
  const registry = new Map();
  const sys = hostSystem({
    platform,
    home: join(root, "home"),
    env: {},
    manifestStore: join(root, "store"),
    registry: { read: (k) => registry.get(k), write: (k, v) => (registry.set(k, v), true), remove: (k) => registry.delete(k) },
  });
  const chrome = { name: HOST, path: program, type: "stdio", allowed_origins: [`chrome-extension://${CHROME_ID}/`] };
  let chromeFile;
  if (platform === "win32") {
    chromeFile = join(root, "chrome-host.json");
    registry.set(`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`, chromeFile);
  } else {
    chromeFile = join(chromeHostDirs(sys)[0], `${HOST}.json`);
    mkdirSync(join(chromeFile, ".."), { recursive: true });
  }
  writeFileSync(chromeFile, JSON.stringify(chrome));
  return { ext, sys, registry };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: the last of two add-ons sharing a created host manifest removes it`, (t) => {
    const f = fixture(t, platform);
    const [a] = registerNativeHosts({ dir: f.ext, addonId: FIRST, chromeId: CHROME_ID }, f.sys);
    const [b] = registerNativeHosts({ dir: f.ext, addonId: SECOND, chromeId: CHROME_ID }, f.sys);
    assert.deepEqual([a.outcome, b.outcome], ["created", "added"]);
    assert.equal(a.file, b.file);

    unregisterNativeHosts(FIRST, f.sys);
    assert.deepEqual(JSON.parse(readFileSync(a.file, "utf-8")).allowed_extensions, [SECOND]);
    unregisterNativeHosts(SECOND, f.sys);
    assert.equal(existsSync(a.file), false, "no manifest listing nobody is left behind");
    assert.equal([...f.registry.keys()].some((k) => k.startsWith("HKCU\\Software\\Mozilla\\")), false);
  });
}
