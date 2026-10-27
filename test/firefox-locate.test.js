import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseAppConstants, readAppConstants } from "../dist/firefox/appconstants.js";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";

const MAC_FIREFOX = "/Applications/Firefox.app";

function install(channel, dir, requireSigning = true) {
  return { binary: `${dir}/firefox`, installDir: dir, channel, version: "159.0", requireSigning };
}

test("without --firefox the release build wins, even when another build was found first", () => {
  const installs = [install("nightly", "/opt/nightly", false), install("release", "/usr/lib/firefox")];
  assert.equal(selectFirefox(installs)?.channel, "release");
  assert.equal(selectFirefox([installs[0]])?.channel, "nightly");
  assert.equal(selectFirefox([]), undefined);
});

test("--firefox takes a channel name, including Developer Edition's aliases", () => {
  const installs = [
    install("release", "/usr/lib/firefox"),
    install("aurora", "/opt/devedition", false),
    install("esr", "/usr/lib/firefox-esr", false),
  ];
  assert.equal(selectFirefox(installs, "ESR")?.installDir, "/usr/lib/firefox-esr");
  assert.equal(selectFirefox(installs, "developer-edition")?.installDir, "/opt/devedition");
  assert.equal(selectFirefox(installs, "aurora")?.installDir, "/opt/devedition");
  assert.equal(selectFirefox(installs, "nightly"), undefined);
  assert.equal(selectFirefox(installs, "constructor"), undefined);
});

test("signing and channel come from AppConstants, including preprocessor-split values", () => {
  // Nightly-style output where //@line markers sit between a key and its value.
  const source = `export var AppConstants = Object.freeze({
  NIGHTLY_BUILD: true,
  MOZ_REQUIRE_SIGNING:
//@line 200 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  false,
//@line 204 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  MOZ_APP_VERSION: "161.0a1",
  MOZ_APP_VERSION_DISPLAY: "161.0a1",
  MOZ_UPDATE_CHANNEL: "nightly",
});`;
  assert.deepEqual(parseAppConstants(source), { requireSigning: false, channel: "nightly", version: "161.0a1" });
  assert.equal(parseAppConstants("export var AppConstants = {};"), null);
});

test("the local release Firefox requires signing", { skip: existsSync(MAC_FIREFOX) ? false : "no /Applications/Firefox.app" }, () => {
  const constants = readAppConstants(`${MAC_FIREFOX}/Contents/MacOS`);
  assert.ok(constants, "AppConstants not found in omni.ja");
  const appIni = readFileSync(`${MAC_FIREFOX}/Contents/Resources/application.ini`, "utf-8");
  assert.equal(constants.version, /^Version=(.+)$/m.exec(appIni)?.[1]);
  if (constants.channel === "release") assert.equal(constants.requireSigning, true);

  const found = findFirefoxInstalls().find((i) => i.installDir === `${MAC_FIREFOX}/Contents/MacOS`);
  assert.ok(found, "findFirefoxInstalls missed /Applications/Firefox.app");
  assert.equal(found.binary, `${MAC_FIREFOX}/Contents/MacOS/firefox`);
  // A path selector finds the same install, given as the .app bundle.
  assert.equal(selectFirefox([], MAC_FIREFOX)?.installDir, found.installDir);
});

test("a directory without omni.ja is not a Firefox install", () => {
  assert.equal(readAppConstants(process.cwd()), null);
  assert.equal(selectFirefox([], process.cwd()), undefined);
});
