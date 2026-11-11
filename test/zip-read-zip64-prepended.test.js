import { test } from "node:test";
import assert from "node:assert/strict";
import { readZipEntry } from "../dist/zip/read.js";
import { buildZip } from "./zip-fixtures.js";

// Bytes prepended to an archive (a stub, a container header) leave every written
// offset short, the zip64 locator's pointer to its end record included.
const stub = Buffer.from("#!/bin/sh\nexit 0\n");

test("a zip64 archive with bytes prepended still reads", () => {
  const zip = buildZip([{ name: "manifest.json", data: '{"name":"x"}', zip64: true }], { zip64Eocd: true });
  assert.equal(readZipEntry(Buffer.concat([stub, zip]), "manifest.json").toString(), '{"name":"x"}');
});

test("a zip64 end record next to plain 32-bit fields doesn't hide the central directory of a shifted archive", () => {
  const zip = buildZip([{ name: "a.txt", data: "alpha" }], { zip64Eocd: true, zip64Maxed: false });
  assert.equal(readZipEntry(zip, "a.txt").toString(), "alpha");
  assert.equal(readZipEntry(Buffer.concat([stub, zip]), "a.txt").toString(), "alpha");
});
