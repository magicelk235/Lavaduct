// Runs a real Firefox, headless and on throwaway profiles only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NAME } from "../dist/name.js";
import { launchFirefox, quitFirefoxForProfile } from "../dist/firefox/launch.js";
import { findFirefoxInstalls, selectFirefox } from "../dist/firefox/locate.js";
import { platform } from "../dist/firefox/platform/index.js";
import { profileInUse } from "../dist/firefox/profiles.js";
import { runCli, runCliAsync, sampleExtension, tempDir, writeFiles } from "./cli-helpers.js";

const firefox = selectFirefox(findFirefoxInstalls());
const noFirefox = firefox ? false : "no Firefox install found";

// Without --sign, --headless still installs temporarily: a Firefox without a
// window can't show the install prompt the other routes rely on.
test("--install --headless loads the add-on temporarily into Firefox, then quits it", { skip: noFirefox, timeout: 180_000 }, (t) => {
  const ext = writeFiles(tempDir(t), sampleExtension());
  const profile = tempDir(t);
  const out = join(tempDir(t), "out");
  const res = runCli([ext, "--install", "--headless", "--profile", profile, "--addon-id", "panel@example.com", "-o", out], {
    state: tempDir(t),
  });

  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /› Signing \(temporary\)/);
  assert.ok(res.stderr.includes(`✓ Installed → ${profile}`), res.stderr);
  assert.match(res.stderr, /panel@example\.com/);
  assert.equal(profileInUse(profile), false, "the headless Firefox is still running");
});

/**
 * A site that records what its pages and the add-ons' content scripts report,
 * and Chrome extensions that open one of its pages.
 */
async function reportingSite(t) {
  const reports = [];
  // The page reports too: that's what a site's sign-in check sees.
  const page =
    "<!doctype html><title>Sign in</title><script>" +
    'fetch("/report?from=page&on=" + new URLSearchParams(location.search).get("opened-by") + "&webdriver=" + navigator.webdriver);' +
    "</script>";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/report") reports.push(Object.fromEntries(url.searchParams));
    res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
    res.end(url.pathname === "/page" ? page : "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  return {
    reports,
    /** The report from `from` on the page `on` opened, for each pair; undefined for any that never came. */
    async waitFor(...wanted) {
      let found = [];
      for (let i = 0; i < 600; i++) {
        found = wanted.map(([from, on]) => reports.find((r) => r.from === from && r.on === on));
        if (!found.includes(undefined)) break;
        await sleep(100);
      }
      return found;
    },
    /** A Chrome extension that opens a page here and reports navigator.webdriver from its content script. */
    extension(name) {
      return writeFiles(tempDir(t), {
        "manifest.json": {
          manifest_version: 3,
          name,
          version: "1.0",
          background: { service_worker: "sw.js" },
          content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
        },
        "sw.js": `chrome.tabs.create({ url: "http://127.0.0.1:${port}/page?opened-by=${name}" });\n`,
        "content.js":
          `fetch("http://127.0.0.1:${port}/report?from=${name}&on=" + new URLSearchParams(location.search).get("opened-by") + ` +
          `"&webdriver=" + navigator.webdriver);\n`,
      });
    },
  };
}

// Started the way the CLI starts a Firefox the user sees, but without a window.
const NO_WINDOW = { MOZ_HEADLESS: "1" };

/** Stop the Firefox a run left on the profile, including a windowless one taskkill can't close. */
async function stopFirefox(profile) {
  if (await quitFirefoxForProfile(firefox, profile)) return;
  const holder = platform.lockHolder(profile, { pathForName: () => undefined, defaultForBinary: () => undefined });
  if (holder) process.kill(holder.pid);
  for (let i = 0; i < 300 && profileInUse(profile); i++) await sleep(100);
}

test(
  "a temporary install doesn't flag the browser as automated, and the next one joins the same Firefox",
  { skip: noFirefox, timeout: 240_000 },
  async (t) => {
    const site = await reportingSite(t);
    const profile = tempDir(t);
    const state = tempDir(t);
    const run = (name, extra = []) =>
      runCliAsync(
        [site.extension(name), "--install", "--sign", "temporary", "--profile", profile, "--addon-id", `${name}@example.com`,
          "-o", join(tempDir(t), "out"), ...extra],
        { state, env: NO_WINDOW },
      );
    try {
      const first = await run("first");
      assert.equal(first.code, 0, first.stderr);
      assert.ok(first.stderr.includes(`✓ Installed → ${profile}`), first.stderr);
      const [page, content] = await site.waitFor(["page", "first"], ["first", "first"]);
      assert.ok(content, `the add-on's content script never ran; reports: ${JSON.stringify(site.reports)}`);
      assert.equal(page?.webdriver, "false", "the page sees navigator.webdriver = true, so sign-in checks take Firefox for a bot");
      assert.equal(content.webdriver, "false");

      // Restarting Firefox would drop the first add-on, and with
      // --no-firefox-restart the run would refuse to.
      const second = await run("second", ["--no-firefox-restart"]);
      assert.equal(second.code, 0, second.stderr);
      assert.ok(second.stderr.includes(`✓ Installed → ${profile}`), second.stderr);
      const [own, earlier] = await site.waitFor(["second", "second"], ["first", "second"]);
      assert.ok(own, "the second add-on's content script never ran");
      assert.ok(earlier, "the first add-on is gone from the Firefox the second run used");
      assert.equal(own.webdriver, "false");
    } finally {
      await stopFirefox(profile);
    }
  },
);

test(
  "a temporary install restarts a Firefox an earlier version left under WebDriver control, and pages stop seeing automation",
  { skip: noFirefox || (process.platform === "win32" ? "taskkill can't close a Firefox without windows" : false), timeout: 240_000 },
  async (t) => {
    const site = await reportingSite(t);
    const profile = tempDir(t);
    // How earlier versions left Firefox running: with its WebDriver BiDi agent.
    const earlier = launchFirefox(firefox, ["--remote-debugging-port", "0", "--profile", profile], { headless: true });
    try {
      for (let i = 0; i < 300 && !profileInUse(profile); i++) await sleep(100);
      const res = await runCliAsync(
        [site.extension("addon"), "--install", "--sign", "temporary", "--profile", profile, "--addon-id", "addon@example.com",
          "-o", join(tempDir(t), "out")],
        { state: tempDir(t), env: NO_WINDOW },
      );
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stderr, /Quitting the Firefox that has .* open, to restart it with remote debugging on/);
      const [page] = await site.waitFor(["page", "addon"]);
      assert.equal(page?.webdriver, "false");
    } finally {
      if (earlier.exitCode === null && earlier.signalCode === null) {
        earlier.kill();
        await once(earlier, "exit");
      }
      await stopFirefox(profile);
    }
  },
);

test(
  "with --no-firefox-restart, a temporary install leaves alone a Firefox that has the profile open without remote debugging",
  { skip: noFirefox, timeout: 180_000 },
  async (t) => {
    const profile = tempDir(t);
    // Where an earlier run's Firefox listened before it quit; the user has
    // since opened the profile in a Firefox of their own.
    writeFileSync(join(profile, `${NAME}-debugger.json`), JSON.stringify({ path: join(profile, `${NAME}-debugger-gone`, "socket") }));
    const own = launchFirefox(firefox, ["--profile", profile], { headless: true });
    try {
      for (let i = 0; i < 300 && !profileInUse(profile); i++) await sleep(100);
      assert.equal(profileInUse(profile), true);
      const res = await runCliAsync(
        [writeFiles(tempDir(t), sampleExtension()), "--install", "--sign", "temporary", "--no-firefox-restart", "--profile", profile,
          "--addon-id", "panel@example.com", "-o", join(tempDir(t), "out")],
        { state: tempDir(t) },
      );
      assert.equal(res.code, 1, res.stderr);
      assert.match(res.stderr, /has to restart it with remote debugging on; quit Firefox first, or drop --no-firefox-restart/);
      assert.equal(own.exitCode, null, "the run quit the user's Firefox");
    } finally {
      if (own.exitCode === null && own.signalCode === null) {
        own.kill();
        await once(own, "exit");
      }
    }
  },
);
