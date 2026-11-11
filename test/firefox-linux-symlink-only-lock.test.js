import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockState } from "../dist/firefox/platform/linux.js";

// Where fcntl locks fail (NFS without a lock daemon), Linux Firefox still
// creates .parentlock but locks the profile with the `lock` symlink alone,
// `<ip>:<pid>`. Beside a working fcntl lock it writes `<ip>:+<pid>` instead.
// nsProfileLock::Lock.

const skip = process.platform === "win32" ? "needs POSIX symlinks" : false;

function withProfile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "lavaduct-symlock-"));
  try {
    writeFileSync(join(dir, ".parentlock"), "");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Linux: a symlink-only lock counts when /proc/locks has no fcntl lock on .parentlock", { skip }, () => {
  withProfile((profile) => {
    symlinkSync(`127.0.1.1:${process.pid}`, join(profile, "lock"));
    assert.deepEqual(lockState(profile, () => ""), { locked: true, pid: process.pid });
  });
});

test("Linux: the obsolete symlink an fcntl-locking Firefox left doesn't count without its fcntl lock", { skip }, () => {
  withProfile((profile) => {
    symlinkSync(`127.0.1.1:+${process.pid}`, join(profile, "lock"));
    assert.deepEqual(lockState(profile, () => ""), { locked: false });
  });
});
