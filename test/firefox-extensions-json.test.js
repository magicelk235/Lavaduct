import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledAddons } from "../dist/firefox/extensions-json.js";

// Trimmed from a Firefox 158 profile, plus a user-installed and a disabled extension.
const EXTENSIONS_JSON = {
  schemaVersion: 37,
  addons: [
    {
      id: "formautofill@mozilla.org",
      version: "1.0.1",
      type: "extension",
      defaultLocale: { name: "Form Autofill" },
      visible: true,
      active: true,
      userDisabled: false,
      hidden: true,
      location: "app-builtin-addons",
    },
    {
      id: "default-theme@mozilla.org",
      version: "1.4.2",
      type: "theme",
      defaultLocale: { name: "System theme — auto" },
      active: true,
      userDisabled: false,
      hidden: false,
      location: "app-builtin",
    },
    {
      id: "en-GB@dictionaries.addons.mozilla.org",
      version: "3.0",
      type: "dictionary",
      defaultLocale: { name: "English (GB) Dictionary" },
      active: true,
      userDisabled: false,
      location: "app-profile",
    },
    {
      id: "uBlock0@raymondhill.net",
      version: "1.62.0",
      type: "extension",
      defaultLocale: { name: "uBlock Origin" },
      active: true,
      userDisabled: false,
      hidden: false,
      location: "app-profile",
    },
    {
      id: "dark-reader.1a2b3c4d@lavaduct",
      version: "4.9.96.1",
      type: "extension",
      defaultLocale: { name: "Dark Reader" },
      active: false,
      userDisabled: true,
      hidden: false,
      location: "app-profile",
    },
  ],
};

function withProfile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "lavaduct-ext-json-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("lists the profile's extensions as about:addons does, without built-ins or themes", () => {
  withProfile((dir) => {
    writeFileSync(join(dir, "extensions.json"), JSON.stringify(EXTENSIONS_JSON));
    assert.deepEqual(readInstalledAddons(dir), [
      {
        id: "uBlock0@raymondhill.net",
        name: "uBlock Origin",
        version: "1.62.0",
        active: true,
        userDisabled: false,
        type: "extension",
        location: "app-profile",
      },
      {
        id: "dark-reader.1a2b3c4d@lavaduct",
        name: "Dark Reader",
        version: "4.9.96.1",
        active: false,
        userDisabled: true,
        type: "extension",
        location: "app-profile",
      },
    ]);
  });
});

test("a profile Firefox hasn't started has no add-ons; a corrupt file is an error", () => {
  withProfile((dir) => {
    assert.deepEqual(readInstalledAddons(dir), []);
    writeFileSync(join(dir, "extensions.json"), '{"schemaVersion":37,"addons":[');
    assert.throws(() => readInstalledAddons(dir), /Can't read .*extensions\.json/);
  });
});
