// Chrome lets an MV3 extension_pages policy name a local dev server in script-src
// (Sider ships http://localhost:8097/, React DevTools' standalone port); a packed
// extension's pages never load scripts from it. Firefox takes a localhost source
// only from temporarily loaded add-ons: a signed or unsigned install drops the whole
// policy, 'wasm-unsafe-eval' included, so the add-on's WebAssembly stops compiling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeManifest, transformManifest, DEFAULT_MIN_FIREFOX } from "../dist/manifest/manifest.js";
import { summarizeManifestChanges } from "../dist/analyze/report.js";
import { firefox, firefoxInstalledManifest } from "./firefox-load.js";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh.0123abcd@lavaduct";
const options = { addonId: ID, minFirefoxVersion: DEFAULT_MIN_FIREFOX, platforms: "desktop", version: "1.0" };
const SIDER = "script-src 'self' http://localhost:8097/ 'wasm-unsafe-eval'; object-src 'self'";
const manifest = (pages, mv = 3) => ({
  manifest_version: mv,
  name: "Dev server",
  version: "1.0",
  content_security_policy: mv === 3 ? { extension_pages: pages } : pages,
});
const pagesCsp = (m) => transformManifest(m, [], options).content_security_policy.extension_pages;

test("localhost sources leave an MV3 script-src and worker-src", () => {
  assert.equal(pagesCsp(manifest(SIDER)), "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
  assert.equal(
    pagesCsp(manifest("script-src 'self' http://127.0.0.1:3000 https://LOCALHOST/x.js 'wasm-unsafe-eval'; worker-src 'self' http://localhost:*")),
    "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'",
  );
});

test("other directives, other hosts and MV2 policies are left alone", () => {
  // Firefox checks only script-src and worker-src, and allows localhost everywhere in MV2.
  const connect = "script-src 'self'; connect-src http://localhost:3000 ws://localhost:3000; img-src http://127.0.0.1";
  assert.equal(pagesCsp(manifest(connect)), connect);
  const plain = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
  assert.equal(pagesCsp(manifest(plain)), plain);
  const ipv6 = "script-src 'self' http://[::1]:3000";
  assert.equal(pagesCsp(manifest(ipv6)), ipv6);
  const mv2 = "script-src 'self' http://localhost:8097; object-src 'self'";
  assert.equal(transformManifest(manifest(mv2, 2), [], options).content_security_policy, mv2);
});

test("the analyzer reports the removal instead of calling localhost a remote origin", () => {
  const { issues } = analyzeManifest(manifest(SIDER), { minFirefox: DEFAULT_MIN_FIREFOX });
  assert.equal(issues.filter((i) => i.message.includes("remote origin")).length, 0, issues.map((i) => i.message).join("\n"));
  const [issue] = issues.filter((i) => i.message.includes("http://localhost:8097/"));
  assert.equal(issue?.autoFixed, true);
  const before = manifest(SIDER);
  const changes = summarizeManifestChanges(before, transformManifest(before, [], options));
  assert.ok(changes.some((c) => c.includes("http://localhost:8097/")), changes.join("\n"));
});

test("an installed Firefox add-on keeps the converted policy, and drops Chrome's", { skip: firefox ? false : "no Firefox install found", timeout: 180_000 }, async () => {
  const chrome = { ...manifest(SIDER), background: { scripts: ["bg.js"] }, browser_specific_settings: { gecko: { id: ID } } };
  const asIs = await firefoxInstalledManifest(chrome, { "bg.js": "" });
  assert.equal(asIs.manifest.content_security_policy.extension_pages, null, "Firefox now keeps a localhost source; the rewrite may be unnecessary");

  const { errors, warnings, manifest: read } = await firefoxInstalledManifest(transformManifest(chrome, [], options), { "bg.js": "" });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(read.content_security_policy.extension_pages, "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
});
