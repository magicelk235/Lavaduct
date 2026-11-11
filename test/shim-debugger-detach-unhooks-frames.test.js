import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { makePage, setup } from "./debugger-sandbox.js";

// Attaching answers alert/confirm/prompt in every frame of the tab, so a dialog
// can't block the session. Detaching has to give every frame its own dialogs
// back: a frame left hooked keeps answering confirm() with true, unseen by the
// user, after the add-on let go of the tab.
test("detaching restores the dialogs of every frame it hooked", async () => {
  const top = makePage();
  const child = makePage({ href: "https://frame.test/" });
  const { bg } = setup({ page: top, frames: { 0: top, 7: child } });
  const b = bg.browser;
  const confirmIn = (page) => vm.runInContext("window.confirm('Delete?')", page);

  await b.debugger.attach({ tabId: 1 });
  assert.equal(confirmIn(top), true, "answered in the top frame while attached");
  assert.equal(confirmIn(child), true, "answered in the child frame while attached");

  await b.debugger.detach({ tabId: 1 });
  assert.equal(confirmIn(top), "native confirm");
  assert.equal(confirmIn(child), "native confirm");
});
