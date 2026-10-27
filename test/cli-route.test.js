import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseRoute } from "../dist/convert.js";

const release = { channel: "release", version: "159.0", requireSigning: true };
const nightly = { channel: "nightly", version: "161.0a1", requireSigning: false };

test("auto signs through AMO whenever credentials are set", () => {
  assert.equal(chooseRoute("auto", true, release).route, "amo");
  assert.equal(chooseRoute("auto", true, nightly).route, "amo");
});

test("auto installs unsigned into a Firefox that allows it", () => {
  assert.equal(chooseRoute("auto", false, nightly).route, "unsigned");
});

test("auto falls back to a temporary install on a Firefox that requires signing", () => {
  const choice = chooseRoute("auto", false, release);
  assert.equal(choice.route, "temporary");
  assert.match(choice.reason, /signed/);
});

test("a forced route that can't work is refused with the reason", () => {
  assert.throws(() => chooseRoute("unsigned", false, release), /Firefox 159\.0 \(release\).*signed/);
  assert.throws(() => chooseRoute("amo", false, nightly), /AMO/);
  assert.equal(chooseRoute("unsigned", false, nightly).route, "unsigned");
  assert.equal(chooseRoute("temporary", true, release).route, "temporary");
});
