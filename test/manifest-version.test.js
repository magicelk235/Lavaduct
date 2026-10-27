import { test } from "node:test";
import assert from "node:assert/strict";
import { toFirefoxVersion } from "../dist/manifest/manifest.js";

test("versions longer than four parts keep the first four", () => {
  assert.equal(toFirefoxVersion("1.2.3.4.5"), "1.2.3.4");
});

test("leading zeros and suffixes are dropped", () => {
  assert.equal(toFirefoxVersion("01.2-beta"), "1.2");
  assert.equal(toFirefoxVersion("1.00.3"), "1.0.3");
});

test("a pre-release suffix never turns into an extra component", () => {
  // "1.2.3.1" would sort above the final 1.2.3 release, so AMO could never take it.
  assert.equal(toFirefoxVersion("1.2.3-beta.1"), "1.2.3");
});

test("parts longer than nine digits are clamped, not cut", () => {
  assert.equal(toFirefoxVersion("2.20261027123"), "2.999999999");
});

test("a version with no leading number becomes 0.0.0", () => {
  assert.equal(toFirefoxVersion(""), "0.0.0");
  assert.equal(toFirefoxVersion("beta"), "0.0.0");
});

test("a valid Firefox version comes back unchanged", () => {
  for (const v of ["1", "0.0.0", "2026.5.1", "13.38.2.0", "999999999.1"]) assert.equal(toFirefoxVersion(v), v);
});
