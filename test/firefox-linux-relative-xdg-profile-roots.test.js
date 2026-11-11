import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linux } from "../dist/firefox/platform/linux.js";

// Firefox ignores a relative XDG_CONFIG_HOME and keeps its profiles in
// ~/.config/mozilla/firefox, so the roots --doctor lists profiles from must
// too, rather than a folder relative to wherever lavaduct runs.

test("Linux: a relative XDG_CONFIG_HOME doesn't move the XDG profile root --doctor reads", () => {
  const home = mkdtempSync(join(tmpdir(), "lavaduct-rel-xdg-"));
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = "relative-config";
  try {
    const roots = linux.profileRoots();
    assert.ok(roots.includes(join(home, ".config", "mozilla", "firefox")), roots.join("\n"));
    assert.ok(!roots.some((r) => r.startsWith("relative-config")), roots.join("\n"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
