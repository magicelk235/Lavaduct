// The analyzer warns that setTimeout/setInterval are unreliable in the background
// because Firefox unloads an idle event page. An MV2 background that is persistent
// (the MV2 default, kept by the conversion; Firefox 106+ honours it) never unloads,
// so the warning was a false positive there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanExtension } from "../dist/analyze/analyze.js";

const MIN = { minFirefox: "153.0" };

function timers(t, background, manifestVersion = 2) {
  const dir = mkdtempSync(join(tmpdir(), "analyze-timer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "background.js"), "setInterval(poll, 60000);\n");
  const manifest = { manifest_version: manifestVersion, name: "Timers", version: "1", background };
  return scanExtension(dir, manifest, MIN).filter((i) => i.category === "background" && /setTimeout/.test(i.message));
}

test("an MV2 persistent background page gets no timer warning", (t) => {
  assert.deepEqual(timers(t, { scripts: ["background.js"] }), []);
  assert.deepEqual(timers(t, { scripts: ["background.js"], persistent: true }), []);
});

test("an event page or a service worker still does", (t) => {
  assert.equal(timers(t, { scripts: ["background.js"], persistent: false }).length, 1);
  assert.equal(timers(t, { service_worker: "background.js" }, 3).length, 1);
});
