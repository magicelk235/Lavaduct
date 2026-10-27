import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  firefoxExesFromReg,
  parseProcessJson,
  pickLockHolder,
  profileFromArgs,
  splitCommandLine,
} from "../dist/firefox/platform/win32.js";
import {
  linuxInstallCandidates,
  linuxProfileRoot,
  procLocksHolder,
  resolveLauncher,
} from "../dist/firefox/platform/linux.js";

const posixOnly = process.platform === "win32" ? "needs POSIX symlinks and PATH lookup" : false;

function withTree(fn) {
  const dir = mkdtempSync(join(tmpdir(), "lavaduct-platform-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function touch(path, content = "") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

test("Windows: registry lookup finds every Firefox brand and skips other Mozilla products", () => {
  const output = [
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Mozilla\\Mozilla Firefox\\159.0 (x64 en-US)\\Main",
    "    PathToExe    REG_SZ    C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Mozilla\\Mozilla Firefox\\153.6.0 ESR (x64 en-US)\\Main",
    "    PathToExe    REG_SZ    C:\\Program Files\\Mozilla Firefox ESR\\firefox.exe",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Mozilla\\Mozilla Firefox 153.6.0 ESR\\bin",
    "    PathToExe    REG_SZ    C:\\Program Files\\Mozilla Firefox ESR\\firefox.exe",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Mozilla\\Mozilla Thunderbird\\140.4.0esr (x64 en-US)\\Main",
    "    PathToExe    REG_SZ    C:\\Program Files\\Mozilla Thunderbird\\thunderbird.exe",
    "",
    "HKEY_CURRENT_USER\\SOFTWARE\\Mozilla\\Nightly\\161.0a1 (x64 en-US)\\Main",
    "    PathToExe    REG_SZ    C:\\Users\\me\\AppData\\Local\\Firefox Nightly\\firefox.exe",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Mozilla\\Firefox Developer Edition\\160.0b1 (x64 en-US)\\Main",
    "    PathToExe    REG_SZ    C:\\Program Files\\Firefox Developer Edition\\firefox.exe",
    "",
    "End of search: 6 match(es) found.",
    "",
  ].join("\r\n");
  assert.deepEqual(firefoxExesFromReg(output), [
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files\\Mozilla Firefox ESR\\firefox.exe",
    "C:\\Program Files\\Mozilla Firefox ESR\\firefox.exe",
    "C:\\Users\\me\\AppData\\Local\\Firefox Nightly\\firefox.exe",
    "C:\\Program Files\\Firefox Developer Edition\\firefox.exe",
  ]);
});

test("Windows: command lines split like CommandLineToArgvW", () => {
  assert.deepEqual(
    splitCommandLine('"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -P "My Profile" -url "a \\"b\\""'),
    ["C:\\Program Files\\Mozilla Firefox\\firefox.exe", "-P", "My Profile", "-url", 'a "b"'],
  );
  assert.deepEqual(splitCommandLine('C:\\ff\\firefox.exe --profile "C:\\dir with space\\\\" next'), [
    "C:\\ff\\firefox.exe",
    "--profile",
    "C:\\dir with space\\",
    "next",
  ]);
});

test("Windows: the profile a Firefox command line asks for", () => {
  assert.deepEqual(profileFromArgs(["-P", "work"]), { name: "work" });
  assert.deepEqual(profileFromArgs(["/p", "work"]), { name: "work" });
  assert.deepEqual(profileFromArgs(["--profile", "D:\\p"]), { path: "D:\\p" });
  assert.deepEqual(profileFromArgs(["-P", "work", "-profile", "D:\\p"]), { path: "D:\\p" });
  assert.deepEqual(profileFromArgs(["--profile=D:\\p q"]), { path: "D:\\p q" });
  assert.deepEqual(profileFromArgs(["-p=work"]), { name: "work" });
  // A bare -P opens the Profile Manager rather than a profile.
  assert.equal(profileFromArgs(["-P"]), undefined);
  assert.equal(profileFromArgs(["-P", "-foreground"]), undefined);
  assert.equal(profileFromArgs(["-P", "/foreground"]), undefined);
  assert.equal(profileFromArgs(["-url", "https://example.com"]), undefined);
});

test("Windows: the quit goes to the browser process holding the profile", () => {
  const exe = "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
  const remoteCommandLine = `"${exe}" --remote-debugging-port 0 --profile D:\\dedicated`;
  const json = JSON.stringify([
    // Child processes have no profile flag; taken for a default-profile browser
    // they would get the quit request and nothing would close.
    { ProcessId: 11, ExecutablePath: exe, CommandLine: `"${exe}" -contentproc --channel="20.1" -childID 1 tab` },
    { ProcessId: 12, ExecutablePath: exe, CommandLine: `"${exe}" -backgroundtask removeDirectory` },
    { ProcessId: 20, ExecutablePath: exe, CommandLine: `"${exe}"` },
    { ProcessId: 30, ExecutablePath: exe, CommandLine: `"${exe}" -P work` },
    { ProcessId: 40, ExecutablePath: exe, CommandLine: `"${exe}" --profile "D:\\profiles\\temp profile"` },
    { ProcessId: 50, ExecutablePath: null, CommandLine: null },
    // Under --remote-debugging-port the launcher waits for the browser it
    // started, with the same command line; WM_CLOSE to the launcher does nothing.
    { ProcessId: 60, ParentProcessId: 5, ExecutablePath: exe, CommandLine: remoteCommandLine },
    { ProcessId: 61, ParentProcessId: 60, ExecutablePath: exe, CommandLine: remoteCommandLine },
  ]);
  const processes = parseProcessJson(json);
  assert.equal(processes.length, 8);
  const lookup = {
    pathForName: (name) => (name === "work" ? "/profiles/work" : undefined),
    defaultForBinary: () => "/profiles/default",
  };
  assert.deepEqual(pickLockHolder(processes, "/profiles/default", lookup), { pid: 20, exe });
  assert.equal(pickLockHolder(processes, "/profiles/work", lookup)?.pid, 30);
  assert.equal(pickLockHolder(processes, "D:\\profiles\\temp profile", lookup)?.pid, 40);
  assert.equal(pickLockHolder(processes, "D:\\dedicated", lookup)?.pid, 61);
  assert.equal(pickLockHolder(processes, "/profiles/other", lookup), undefined);
  // PowerShell prints a lone object, not an array, for a single process.
  assert.deepEqual(parseProcessJson(JSON.stringify({ ProcessId: 7, ExecutablePath: exe, CommandLine: null })), [
    { pid: 7, parentPid: undefined, exe, commandLine: undefined },
  ]);
  assert.deepEqual(parseProcessJson(""), []);
});

test("Linux: /proc/locks gives the PID holding a lock, not one waiting for it", () => {
  const procLocks = [
    "1: POSIX  ADVISORY  WRITE 5124 00:2b:1311 0 EOF",
    "2: FLOCK  ADVISORY  WRITE 801 00:19:3 0 EOF",
    "3: OFDLCK ADVISORY  READ  -1 00:06:9028 0 EOF",
    "4: POSIX  ADVISORY  WRITE 7001 fd:01:7777 0 EOF",
    "4: -> POSIX  ADVISORY  WRITE 6000 fd:01:7777 0 EOF",
    "",
  ].join("\n");
  assert.deepEqual(procLocksHolder(procLocks, 1311n), { pid: 5124 });
  assert.deepEqual(procLocksHolder(procLocks, 7777n), { pid: 7001 });
  assert.deepEqual(procLocksHolder(procLocks, 9028n), { pid: -1 });
  assert.equal(procLocksHolder(procLocks, 424242n), undefined);
});

test("Linux: launchers on PATH lead to their install, through symlinks and wrapper scripts", { skip: posixOnly }, () => {
  withTree((root) => {
    // Fedora: /usr/bin/firefox is a script that builds the path from MOZ_LIB_DIR.
    touch(join(root, "usr/lib64/firefox/omni.ja"));
    touch(
      join(root, "bin/firefox"),
      '#!/usr/bin/bash\nMOZ_LIB_DIR="/usr/lib64"\nMOZ_FIREFOX_FILE="firefox"\n' +
        'MOZ_DIST_BIN="$MOZ_LIB_DIR/firefox"\nexec $MOZ_DIST_BIN/$MOZ_FIREFOX_FILE "$@"\n',
    );
    // Arch: the script execs the binary by absolute path.
    touch(join(root, "usr/lib/firefox-developer-edition/omni.ja"));
    touch(
      join(root, "bin/firefox-developer-edition"),
      '#!/bin/sh\nexec /usr/lib/firefox-developer-edition/firefox "$@"\n',
    );
    // Debian: a symlink into the install directory.
    touch(join(root, "usr/lib/firefox-esr/omni.ja"));
    touch(join(root, "usr/lib/firefox-esr/firefox-esr"));
    symlinkSync(join(root, "usr/lib/firefox-esr/firefox-esr"), join(root, "bin/firefox-esr"));
    // Ubuntu: /usr/bin/firefox only forwards to the snap.
    touch(join(root, "bin/firefox-nightly"), "#!/bin/sh\nexec /snap/bin/firefox \"$@\"\n");

    assert.equal(resolveLauncher(join(root, "bin/firefox"), root)?.installDir, join(root, "usr/lib64/firefox"));
    assert.equal(
      resolveLauncher(join(root, "bin/firefox-developer-edition"), root)?.installDir,
      join(root, "usr/lib/firefox-developer-edition"),
    );
    assert.deepEqual(resolveLauncher(join(root, "bin/firefox-esr"), root), {
      binary: join(root, "bin/firefox-esr"),
      installDir: realpathSync(join(root, "usr/lib/firefox-esr")),
    });
    assert.equal(resolveLauncher(join(root, "bin/firefox-nightly"), root), undefined);
  });
});

test("Linux: snap and Flatpak installs are found next to the ones on PATH", { skip: posixOnly }, () => {
  withTree((root) => {
    const home = join(root, "home/me");
    touch(join(root, "usr/lib/firefox/omni.ja"));
    touch(join(root, "bin/firefox"), '#!/bin/sh\nexec /usr/lib/firefox/firefox "$@"\n');
    touch(join(root, "snap/firefox/current/usr/lib/firefox/omni.ja"));
    const flatpak = join(home, ".local/share/flatpak");
    touch(join(flatpak, "app/org.mozilla.firefox/current/active/files/lib/firefox/omni.ja"));
    touch(join(flatpak, "exports/bin/org.mozilla.firefox"), "#!/bin/sh\n");

    const savedPath = process.env.PATH;
    process.env.PATH = join(root, "bin");
    try {
      assert.deepEqual(linuxInstallCandidates(root, home), [
        { binary: join(root, "bin/firefox"), installDir: join(root, "usr/lib/firefox") },
        {
          binary: join(root, "snap/bin/firefox"),
          installDir: join(root, "snap/firefox/current/usr/lib/firefox"),
          sandbox: "snap",
        },
        {
          binary: join(flatpak, "exports/bin/org.mozilla.firefox"),
          installDir: join(flatpak, "app/org.mozilla.firefox/current/active/files/lib/firefox"),
          sandbox: "flatpak",
        },
      ]);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

test("Linux: each kind of install reads its own profile root", () => {
  withTree((home) => {
    // Firefox 147+ with no ~/.mozilla yet: XDG config dir.
    assert.equal(linuxProfileRoot(undefined, home, {}), join(home, ".config/mozilla/firefox"));
    assert.equal(linuxProfileRoot(undefined, home, { XDG_CONFIG_HOME: "/cfg" }), "/cfg/mozilla/firefox");
    // A relative XDG_CONFIG_HOME is invalid by the XDG spec and ignored.
    assert.equal(linuxProfileRoot(undefined, home, { XDG_CONFIG_HOME: "cfg" }), join(home, ".config/mozilla/firefox"));
    assert.equal(linuxProfileRoot(undefined, home, { MOZ_LEGACY_HOME: "1" }), join(home, ".mozilla/firefox"));
    // Any ~/.mozilla (native messaging hosts, other Mozilla apps) keeps the legacy layout.
    mkdirSync(join(home, ".mozilla/native-messaging-hosts"), { recursive: true });
    assert.equal(linuxProfileRoot(undefined, home, {}), join(home, ".mozilla/firefox"));

    assert.equal(linuxProfileRoot("snap", home, {}), join(home, "snap/firefox/common/.mozilla/firefox"));
    assert.equal(linuxProfileRoot("flatpak", home, {}), join(home, ".var/app/org.mozilla.firefox/config/mozilla/firefox"));
    mkdirSync(join(home, ".var/app/org.mozilla.firefox/.mozilla/firefox"), { recursive: true });
    assert.equal(linuxProfileRoot("flatpak", home, {}), join(home, ".var/app/org.mozilla.firefox/.mozilla/firefox"));
  });
});

test("Linux: --firefox pointing into the snap or the Flatpak is treated as sandboxed", { skip: posixOnly }, () => {
  withTree((root) => {
    const snapDir = join(root, "snap/firefox/current/usr/lib/firefox");
    touch(join(snapDir, "omni.ja"));
    touch(join(snapDir, "firefox"));
    const flatpakDir = join(root, "var/lib/flatpak/app/org.mozilla.firefox/current/active/files/lib/firefox");
    touch(join(flatpakDir, "omni.ja"));
    touch(join(flatpakDir, "firefox"));
    touch(join(root, "usr/lib/firefox/omni.ja"));
    touch(join(root, "usr/lib/firefox/firefox"));
    assert.equal(resolveLauncher(join(snapDir, "firefox"), root)?.sandbox, "snap");
    assert.equal(resolveLauncher(join(flatpakDir, "firefox"), root)?.sandbox, "flatpak");
    assert.equal(resolveLauncher(join(root, "usr/lib/firefox/firefox"), root)?.sandbox, undefined);
  });
});
