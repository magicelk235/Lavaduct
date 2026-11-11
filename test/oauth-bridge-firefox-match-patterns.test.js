import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOAuthBridge, BRIDGE_PAGE, BRIDGE_PAGE_CS } from "../dist/runtime/oauth-bridge.js";
import { BidiSession } from "../dist/firefox/bidi.js";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";

// Chrome parses externally_connectable.matches with every scheme allowed and
// takes a port wildcard, so `http://localhost:*/*` and `chrome://newtab/*` are
// valid there. The bridge turns the list into content-script matches, and
// Firefox refuses the whole add-on over one pattern its grammar rejects there.

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const MATCHES = ["https://app.example.com/*", "http://localhost:*/*", "chrome://newtab/*"];

function bridged(t) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-patterns-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "bg.js"), "");
  const manifest = {
    manifest_version: 3, name: "Patterns", version: "1",
    browser_specific_settings: { gecko: { id: "patterns@lavaduct.test" } },
    background: { scripts: ["bg.js"] },
    externally_connectable: { matches: MATCHES },
  };
  const notes = applyOAuthBridge(dir, manifest, CHROME_ID);
  return { dir, manifest, notes };
}

test("the bridge's content scripts get patterns Firefox accepts: a port wildcard loses its port, a scheme Firefox can't match is left out", (t) => {
  const { manifest, notes } = bridged(t);
  const [relay, page] = manifest.content_scripts;
  assert.deepEqual(relay.js, [BRIDGE_PAGE_CS]);
  assert.deepEqual(page.js, [BRIDGE_PAGE]);
  assert.deepEqual(relay.matches, ["https://app.example.com/*", "http://localhost/*"]);
  assert.deepEqual(page.matches, relay.matches);
  assert.ok(notes.some((n) => n.includes("chrome://newtab/*")), notes.join("\n"));
});

test("with no pattern Firefox accepts, nothing is wired", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-patterns-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = { manifest_version: 3, name: "P", version: "1", background: { scripts: ["bg.js"] }, externally_connectable: { matches: ["chrome://newtab/*"] } };
  const notes = applyOAuthBridge(dir, manifest, CHROME_ID);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Page bridge skipped: .*chrome:\/\/newtab/);
  assert.equal(manifest.content_scripts, undefined);
});

const firefox = selectFirefox(findFirefoxInstalls());

test(
  "Firefox installs the bridged add-on",
  { skip: firefox ? false : "no Firefox install found", timeout: 120_000 },
  async (t) => {
    const { dir, manifest } = bridged(t);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    const profile = mkdtempSync(join(tmpdir(), "bridge-patterns-profile-"));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    mkdirSync(profile, { recursive: true });
    const session = await BidiSession.start(firefox, profile);
    try {
      assert.equal(await session.installExtension(dir), "patterns@lavaduct.test");
    } finally {
      await session.closeBrowser();
    }
  },
);
