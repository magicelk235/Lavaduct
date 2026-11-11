import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxProfileRoot } from "../dist/firefox/platform/linux.js";

// Firefox 147+ keeps the legacy profile root only when ~/.mozilla/firefox (or
// ~/mozilla, its MOZ_USER_DIR) exists, not when ~/.mozilla does: native
// messaging apps, lavaduct among them, create ~/.mozilla/native-messaging-hosts
// on machines whose Firefox lives in ~/.config/mozilla/firefox.
// nsXREDirProvider::LegacyHomeExists.

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "lavaduct-xdg-legacy-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("Linux: a ~/.mozilla holding only native messaging hosts leaves Firefox on the XDG profile root", () => {
  withHome((home) => {
    mkdirSync(join(home, ".mozilla", "native-messaging-hosts"), { recursive: true });
    assert.equal(linuxProfileRoot(undefined, home, {}), join(home, ".config", "mozilla", "firefox"));
    assert.equal(linuxProfileRoot(undefined, home, { XDG_CONFIG_HOME: "/cfg" }), join("/cfg", "mozilla", "firefox"));

    mkdirSync(join(home, ".mozilla", "firefox"));
    assert.equal(linuxProfileRoot(undefined, home, {}), join(home, ".mozilla", "firefox"));
  });
});

test("Linux: ~/mozilla, Firefox's MOZ_USER_DIR, also keeps the legacy profile root", () => {
  withHome((home) => {
    mkdirSync(join(home, "mozilla"));
    assert.equal(linuxProfileRoot(undefined, home, {}), join(home, ".mozilla", "firefox"));
  });
});

test("Linux: the Flatpak's persisted ~/.mozilla without a firefox folder leaves it on its config folder", () => {
  withHome((home) => {
    const app = join(home, ".var", "app", "org.mozilla.firefox");
    mkdirSync(join(app, ".mozilla", "native-messaging-hosts"), { recursive: true });
    assert.equal(linuxProfileRoot("flatpak", home, {}), join(app, "config", "mozilla", "firefox"));

    mkdirSync(join(app, ".mozilla", "firefox"));
    assert.equal(linuxProfileRoot("flatpak", home, {}), join(app, ".mozilla", "firefox"));
  });
});
