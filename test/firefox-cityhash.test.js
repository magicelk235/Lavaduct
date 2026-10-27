import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cityHash64, installHash } from "../dist/firefox/cityhash.js";

// The pseudo-random input from CityHash's own test suite (city-test.cc).
function testData(size) {
  const mask = (1n << 64n) - 1n;
  const k0 = 0xc3a5c85c97cb3127n;
  const data = Buffer.alloc(size);
  let a = 9n;
  let b = 777n;
  for (let i = 0; i < size; i++) {
    a = (a + b) & mask;
    b = (b + a) & mask;
    a = ((a ^ (a >> 41n)) * k0) & mask;
    b = (((b ^ (b >> 41n)) * k0) & mask) + BigInt(i);
    b &= mask;
    data[i] = Number((b >> 37n) & 0xffn);
  }
  return data;
}

test("cityHash64 matches the C++ reference on every length class", () => {
  // CityHash64(data + len*len, len), computed with Firefox's bundled city.cpp.
  const expected = {
    0: "9AE16A3B2F90404F",
    1: "0A4C09BD9F0E45F0",
    2: "3BE5E76F9931C681",
    3: "1E9CC7D232C7A33F",
    4: "6F1D652A9AA9382E",
    7: "E067868DC58FD396",
    8: "6479C218E3B4A905",
    9: "18009929C10980CF",
    15: "723768CF3FA7B3A8",
    16: "D3362226822B1B09",
    17: "1DC2612576924BBB",
    31: "B4927AE39D53BC5B",
    32: "F3FD396B782F2A99",
    33: "8264C5CFCBFFD0D9",
    63: "0B624E9707EA879F",
    64: "89EECECB3A3883A4",
    65: "BD23872256DBF216",
    127: "DE8E77B45E031E8C",
    128: "43991AC2DAFB5583",
    129: "2367C7674F9B4186",
    200: "408125504020E0F6",
    299: "53FE0795B6908C30",
  };
  const data = testData(299 * 299 + 299);
  for (const [lenText, hex] of Object.entries(expected)) {
    const len = Number(lenText);
    const got = cityHash64(data.subarray(len * len, len * len + len));
    assert.equal(got.toString(16).toUpperCase().padStart(16, "0"), hex, `length ${len}`);
  }
});

test("installHash names the [Install…] section Firefox writes for each install directory", () => {
  assert.equal(installHash("/Applications/Firefox.app/Contents/MacOS"), "2656FF1E876E9973");
  assert.equal(installHash("C:\\Program Files\\Mozilla Firefox"), "308046B0AF4A39CB");
  assert.equal(installHash("/usr/lib/firefox"), "4F96D1932A9F858E");
  assert.equal(installHash("/app/lib/firefox"), "CF146F38BCAB2D21");
  // Firefox prints the hash without zero padding, so some keys are 15 characters.
  assert.equal(installHash("/opt/firefox"), "6AFDA46A1A8AD48");
});

test("installHash matches this Mac's installs.ini", { skip: skipUnlessLocalInstallsIni() }, () => {
  const root = join(homedir(), "Library", "Application Support", "Firefox");
  const sections = [...readFileSync(join(root, "installs.ini"), "utf-8").matchAll(/^\[([0-9A-F]+)\]/gm)].map(
    (m) => m[1],
  );
  const dir = realpathSync("/Applications/Firefox.app/Contents/MacOS");
  assert.ok(sections.includes(installHash(dir)), `${installHash(dir)} not in ${sections.join(", ")}`);
});

function skipUnlessLocalInstallsIni() {
  if (process.platform !== "darwin") return "macOS only";
  const ini = join(homedir(), "Library", "Application Support", "Firefox", "installs.ini");
  if (!existsSync(ini) || !existsSync("/Applications/Firefox.app")) return "no local Firefox install";
  return false;
}
