import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeIdbStringKey } from "../dist/firefox/idb-key.js";

// Expected bytes are the object_data.key values Firefox 158 wrote for
// storage.local.set() calls with these keys.

test("the debug log key encodes to the row key Firefox stores", () => {
  assert.equal(
    encodeIdbStringKey("__viaduct_debug_log__").toString("hex"),
    "306060776a6265766475606566637668606d70686060",
  );
});

test("non-ASCII keys use the two- and three-byte forms and lose trailing zero bytes", () => {
  const stored = {
    "": "30",
    "~\u007f": "307f80",
    "é": "30806a",
    "\u017f": "3081",
    "\u407e": "30bfff",
    "\u407f": "30d01fc0",
    "🚀": "30f60f40f7a0",
  };
  for (const [key, hex] of Object.entries(stored)) {
    assert.equal(encodeIdbStringKey(key).toString("hex"), hex, JSON.stringify(key));
  }
});
