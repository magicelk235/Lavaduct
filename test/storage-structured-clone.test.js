import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readStructuredClone } from "../dist/firefox/structured-clone.js";

// The clone bytes Firefox 158 stored for storage.local.set({ types }) with this value.
const clone = readFileSync(fileURLToPath(new URL("./fixtures/storage/types.clone", import.meta.url)));

function storedValue() {
  const shared = { s: 1 };
  const late = { l: true };
  return {
    7: "index-like key",
    int: 42, negInt: -7, zero: 0, negZero: -0, dbl: 1.5, big: 2 ** 53, tiny: -1e-7, nan: NaN, inf: -Infinity,
    yes: true, no: false, nul: null, undef: undefined,
    latin1: "café", utf16: "日本語 🚀", empty: "", lone: "\ud83d!",
    arr: [1, "two", [3, null]], sparse: [, , 7], emptyArr: [], emptyObj: {},
    nested: { deep: { deeper: [{ x: 1 }] } },
    a: shared, b: shared, inArr: [shared],
    late1: late, late2: late,
  };
}

// Little-endian 8-byte units: [tag, data] pairs, or raw bytes already padded to 8.
function units(...parts) {
  return Buffer.concat(
    parts.map((p) => {
      if (Buffer.isBuffer(p)) return p;
      const b = Buffer.alloc(8);
      b.writeUInt32LE(p[1], 0);
      b.writeUInt32LE(p[0], 4);
      return b;
    }),
  );
}
const HEADER = [0xfff10000, 3];

test("decodes the value Firefox stored for storage.local.set({ types })", () => {
  assert.deepEqual(readStructuredClone(clone), storedValue());
});

test("an object stored more than once comes back as one object", () => {
  const value = readStructuredClone(clone);
  assert.equal(value.a, value.b);
  assert.equal(value.inArr[0], value.a);
  assert.equal(value.late1, value.late2);
});

test("a clone without the scope header still decodes", () => {
  assert.deepEqual(readStructuredClone(clone.subarray(8)), storedValue());
});

// Firefox 162 (bug 2061903) writes the format version in the header's high 16
// bits, next to the scope; older clones leave them zero.
function withHeaderVersion(version) {
  const copy = Buffer.from(clone);
  copy.writeUInt32LE(((version << 16) | copy.readUInt16LE(0)) >>> 0, 0);
  return copy;
}

test("a clone whose header carries the format version, as Firefox 162 writes it, decodes", () => {
  assert.deepEqual(readStructuredClone(withHeaderVersion(9)), storedValue());
});

test("a clone in a format version newer than the reader knows is refused", () => {
  assert.throws(() => readStructuredClone(withHeaderVersion(10)), /version 10/);
});

test("a type the decoder doesn't handle is reported by its tag", () => {
  // A Date, which storage.local can hold but the debug log never does.
  assert.throws(
    () => readStructuredClone(units(HEADER, [0xffff0005, 0], Buffer.alloc(8))),
    /ffff0005/i,
  );
});

test("a truncated clone is rejected", () => {
  assert.throws(() => readStructuredClone(clone.subarray(0, 600)), /truncated/i);
  assert.throws(
    () => readStructuredClone(units(HEADER, [0xffff0004, 0x80000010], Buffer.from("short\0\0\0"))),
    /truncated/i,
  );
});
