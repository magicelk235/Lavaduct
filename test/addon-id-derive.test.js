import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDON_ID_SUFFIX } from "../dist/name.js";
import { deriveAddonId } from "../dist/sign/addon-id.js";

const DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh";

function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "lavaduct-addon-id-"));
  const previous = process.env.LAVADUCT_STATE_DIR;
  process.env.LAVADUCT_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.LAVADUCT_STATE_DIR;
    else process.env.LAVADUCT_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a Web Store extension keeps its Chrome ID plus a per-user salt, within AMO's 80 characters", () => {
  withStateDir(() => {
    const id = deriveAddonId({ chromeId: DARK_READER, name: "Dark Reader" });

    assert.match(id, new RegExp(`^${DARK_READER}\\.[0-9a-f]{8}@${ADDON_ID_SUFFIX}$`));
    assert.ok(id.length <= 80, `${id} is ${id.length} characters`);
    assert.equal(deriveAddonId({ chromeId: DARK_READER, name: "Dark Reader" }), id);
  });
});

test("a local extension gets a Chrome-style ID from its name", () => {
  withStateDir(() => {
    const id = deriveAddonId({ name: "My Extension" });

    assert.match(id, /^[a-p]{32}\.[0-9a-f]{8}@[A-Za-z0-9._-]+$/);
    assert.equal(deriveAddonId({ name: "My Extension" }), id);
    assert.notEqual(deriveAddonId({ name: "Another Extension" }), id);
  });
});

test("the same input keeps its ID across separate runs", () => {
  withStateDir((dir) => {
    const moduleUrl = new URL("../dist/sign/addon-id.js", import.meta.url).href;
    const script = `import { deriveAddonId } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(deriveAddonId({ name: "My Extension" }));`;
    const runOnce = () =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, LAVADUCT_STATE_DIR: dir },
        encoding: "utf-8",
      });

    const first = runOnce();
    assert.match(first, /@/);
    assert.equal(runOnce(), first);
  });
});

test("two users converting the same extension get different IDs", () => {
  const mine = withStateDir(() => deriveAddonId({ chromeId: DARK_READER, name: "Dark Reader" }));
  const theirs = withStateDir(() => deriveAddonId({ chromeId: DARK_READER, name: "Dark Reader" }));

  assert.notEqual(mine, theirs);
});

test("a derived ID longer than AMO allows is an error that points at --addon-id", () => {
  withStateDir(() => {
    assert.throws(() => deriveAddonId({ chromeId: "a".repeat(70), name: "Long" }), /--addon-id/);
  });
});
