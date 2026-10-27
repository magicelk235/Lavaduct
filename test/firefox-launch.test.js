import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { installHash } from "../dist/firefox/cityhash.js";
import { openXpiInFirefox } from "../dist/firefox/launch.js";
import { withFakeHome } from "./firefox-fixtures.js";

// The fake binary writes its arguments next to itself and exits.
async function launchedArgs(installDir) {
  const file = join(installDir, "args.txt");
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(50);
  // Give the script a moment to finish writing.
  await sleep(50);
  const args = readFileSync(file, "utf-8").split("\n").slice(0, -1);
  rmSync(file);
  return args;
}

test(
  "an .xpi opens with -P for a registered profile, --profile otherwise, and always by absolute path",
  { skip: process.platform === "win32" ? "needs a shell script as the fake binary" : false },
  async () => {
    await withFakeHome(async ({ home, root, install }) => {
      writeFileSync(install.binary, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$(dirname "$0")/args.txt"\n');
      chmodSync(install.binary, 0o755);
      const hash = installHash(realpathSync.native(install.installDir));
      writeFileSync(
        join(root, "profiles.ini"),
        `[General]\nVersion=2\n\n[Profile0]\nName=work\nIsRelative=1\nPath=Profiles/a.work\n\n` +
          `[Install${hash}]\nDefault=Profiles/a.work\n`,
      );
      mkdirSync(join(root, "Profiles", "a.work"), { recursive: true });
      const loose = join(home, "loose-profile");
      mkdirSync(loose);
      // Relative, as a user would type it; macOS doesn't forward the working directory.
      const xpi = join("out", "addon.xpi");

      openXpiInFirefox(install, { path: join(root, "Profiles", "a.work"), isDefault: true }, xpi);
      assert.deepEqual((await launchedArgs(install.installDir)).slice(-3), ["-P", "work", resolve(xpi)]);

      openXpiInFirefox(install, { path: loose, isDefault: false }, xpi);
      assert.deepEqual((await launchedArgs(install.installDir)).slice(-3), ["--profile", loose, resolve(xpi)]);
    });
  },
);
