import { test } from "node:test";
import assert from "node:assert/strict";
import { selectFirefox } from "../dist/firefox/locate.js";

// The snap's launcher is a symlink to /usr/bin/snap, so following it leads to
// no Firefox. Passing back the binary lavaduct itself reported has to select
// that install anyway; Viaduct for Linux passes it as --firefox.
test("--firefox with a found install's launcher selects that install", () => {
  const snap = {
    binary: "/snap/bin/firefox",
    installDir: "/snap/firefox/current/usr/lib/firefox",
    channel: "release",
    version: "160.0.1",
    requireSigning: true,
    sandbox: "snap",
  };
  const esr = { ...snap, binary: "/usr/bin/firefox-esr", installDir: "/usr/lib/firefox-esr", channel: "esr" };
  assert.equal(selectFirefox([esr, snap], "/snap/bin/firefox"), snap);
  assert.equal(selectFirefox([esr, snap], "/snap/bin/firefox/../firefox"), snap);
});
