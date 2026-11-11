import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowUnsignedInProfile, raiseStaticRuleLimitInProfile } from "../dist/firefox/install.js";

// Firefox's pref parser skips /* … */ blocks in user.js, and user.js files
// (arkenfox's among them) park prefs inside such blocks. A pref line in a
// block sets nothing, so editing it in place leaves the pref unset.

function withProfile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "lavaduct-userjs-block-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a pref parked inside a /* */ block in user.js is set by a live line, and the block is left alone", () => {
  withProfile((profile) => {
    const userJs = join(profile, "user.js");
    const before =
      'user_pref("browser.startup.page", 3);\n' +
      "/* Disabled for now:\n" +
      'user_pref("xpinstall.signatures.required", true);\n' +
      "*/\n" +
      'user_pref("general.smoothScroll", false); /* trailing */\n';
    writeFileSync(userJs, before);
    assert.deepEqual(allowUnsignedInProfile(profile), { changed: true });
    assert.equal(readFileSync(userJs, "utf-8"), before + 'user_pref("xpinstall.signatures.required", false);\n');
    assert.deepEqual(allowUnsignedInProfile(profile), { changed: false });
  });
});

test("a commented-out rule limit in user.js doesn't count as the profile's limit", () => {
  withProfile((profile) => {
    const userJs = join(profile, "user.js");
    const before = '/*\nuser_pref("extensions.dnr.guaranteed_minimum_static_rules", 500000);\n*/\n';
    writeFileSync(userJs, before);
    assert.deepEqual(raiseStaticRuleLimitInProfile(profile), { changed: true });
    assert.equal(readFileSync(userJs, "utf-8"), before + 'user_pref("extensions.dnr.guaranteed_minimum_static_rules", 330000);\n');
  });
});

test("comment markers inside pref strings don't open a block", () => {
  withProfile((profile) => {
    const userJs = join(profile, "user.js");
    writeFileSync(userJs, 'user_pref("some.url", "https://example.com/*");\nuser_pref("xpinstall.signatures.required", true);\n');
    assert.deepEqual(allowUnsignedInProfile(profile), { changed: true });
    assert.equal(
      readFileSync(userJs, "utf-8"),
      'user_pref("some.url", "https://example.com/*");\nuser_pref("xpinstall.signatures.required", false);\n',
    );
  });
});
