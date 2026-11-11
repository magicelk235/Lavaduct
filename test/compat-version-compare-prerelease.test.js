// Nightly and Beta report versions like 161.0a1 and 160.0b3, which Firefox sorts
// before 161.0 and 160.0. Comparing them as plain numbers called Nightly 161.0a1
// new enough for strict_min_version 161.0, which that Nightly refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareFirefoxVersions } from "../dist/manifest/compat-data.js";
import { firefox } from "./firefox-load.js";
import { startPrivilegedFirefox } from "./firefox-devtools.js";

const PAIRS = [
  ["161.0a1", "161.0"],
  ["161.0a1", "161"],
  ["160.0b3", "160.0"],
  ["160.0b3", "160.0b10"],
  ["161.0a1", "160.0"],
  ["153.6.0", "153.0"],
  ["128.0", "139"],
  ["159.0.1", "159.0"],
  ["139", "139.0.0"],
];

test("a pre-release sorts before its release", () => {
  assert.ok(compareFirefoxVersions("161.0a1", "161.0") < 0);
  assert.ok(compareFirefoxVersions("161.0a1", "161") < 0);
  assert.ok(compareFirefoxVersions("160.0b3", "160.0") < 0);
  assert.ok(compareFirefoxVersions("160.0b3", "160.0b10") < 0);
  assert.ok(compareFirefoxVersions("161.0a1", "160.0") > 0);
  assert.ok(compareFirefoxVersions("153.6.0", "153.0") > 0);
  assert.equal(compareFirefoxVersions("139", "139.0.0"), 0);
});

test("the comparison agrees with Firefox's own", { skip: firefox ? false : "no Firefox install found", timeout: 120_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "lavaduct-vc-"));
  const profile = join(scratch, "profile");
  mkdirSync(profile);
  const ff = await startPrivilegedFirefox(firefox, profile);
  try {
    const theirs = JSON.parse(await ff.chrome(`JSON.stringify(${JSON.stringify(PAIRS)}.map(([a, b]) => Math.sign(Services.vc.compare(a, b))))`));
    assert.deepEqual(PAIRS.map(([a, b]) => Math.sign(compareFirefoxVersions(a, b))), theirs);
  } finally {
    await ff.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
