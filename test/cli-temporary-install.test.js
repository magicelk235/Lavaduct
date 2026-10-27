// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { profileInUse } from "../dist/firefox/profiles.js";
import { runCli, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

const noFirefox = selectFirefox(findFirefoxInstalls()) ? false : "no Firefox install found";

test("--install --sign temporary --headless loads the add-on into Firefox, then quits it", { skip: noFirefox, timeout: 180_000 }, (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const profile = tempDir(t);
  const out = join(tempDir(t), "out");
  const res = runCli(
    [ext, "--install", "--sign", "temporary", "--headless", "--profile", profile, "--addon-id", "panel@example.com", "-o", out],
    { state: tempDir(t) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /› Signing \(temporary\)/);
  assert.ok(res.stderr.includes(`✓ Installed → ${profile}`), res.stderr);
  assert.match(res.stderr, /panel@example\.com/);
  assert.equal(profileInUse(profile), false, "the headless Firefox is still running");
});
