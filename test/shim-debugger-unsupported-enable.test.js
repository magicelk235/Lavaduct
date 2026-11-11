import { test } from "node:test";
import assert from "node:assert/strict";
import { plain } from "./shim-sandbox.js";
import { setup, send } from "./debugger-sandbox.js";

// Any X.enable without an implementation succeeds as a no-op, but Fetch.enable
// means "pause every request until I answer it", which Firefox can't give an
// add-on through the debugger. Taking it silently left the client waiting for
// Fetch.requestPaused events that never come, so it is refused with a reason.
test("Fetch.enable is refused with its reason, other unimplemented enables still succeed", async () => {
  const { bg } = setup();
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  await assert.rejects(send(b, 1, "Fetch.enable", { patterns: [{ urlPattern: "*" }] }), (err) => {
    assert.deepEqual(JSON.parse(err.message), { code: -32000, message: "Fetch.enable isn't available in Firefox: use webRequest instead" });
    return true;
  });
  assert.deepEqual(plain(await send(b, 1, "Log.enable")), {});
});
