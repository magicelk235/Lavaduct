// Runs a real Firefox, headless and on a throwaway profile only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { firefox, driveInFirefox, cleanUp } from "./firefox-debugger-driver.js";

after(cleanUp);

// Enter on a focused <input type=submit|reset|button> activates that button, as
// it does on a <button>. The emulation sent every focused <input> through
// implicit submission instead, so Enter on a form's second submit button
// clicked its first, Enter on a reset button submitted the form, and Enter on
// a plain button submitted its form without running the button's handler.
const PAGE = `<!doctype html><title>Forms</title>
<form id="f1" onsubmit="window.submitted1 = (window.submitted1 || 0) + 1; return false">
  <input id="t1" value="typed">
  <input type="submit" value="Save" onclick="window.clicked = 'save'">
  <input type="submit" id="del" value="Delete" onclick="window.clicked = 'delete'">
  <input type="reset" id="rst" value="Reset">
</form>
<form id="f2" onsubmit="window.submitted2 = (window.submitted2 || 0) + 1; return false">
  <input id="t2">
  <input type="button" id="go" value="Go" onclick="window.went = (window.went || 0) + 1">
</form>
<form id="f3" onsubmit="window.submitted3 = (window.submitted3 || 0) + 1; return false">
  <input id="t3">
</form>`;

const BACKGROUND = String.raw`
async function run() {
  const tab = await openTab(ORIGIN + "/page");
  const { send, evaluate } = await debuggee(tab);
  const enter = async (id) => {
    await evaluate("document.getElementById('" + id + "').focus()");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  const state = () => evaluate("JSON.stringify({ clicked: window.clicked || null, submitted1: window.submitted1 || 0, value: document.getElementById('t1').value, went: typeof window.went === 'number' ? window.went : 0, submitted2: window.submitted2 || 0, submitted3: window.submitted3 || 0 })");
  await enter("del");
  await log("second submit", JSON.parse(await state()));
  await evaluate("window.clicked = null; window.submitted1 = 0; document.getElementById('t1').value = 'changed'");
  await enter("rst");
  await log("reset", JSON.parse(await state()));
  await enter("go");
  await log("button", JSON.parse(await state()));
  await enter("t3");
  await log("text field", JSON.parse(await state()));
}
`;

test(
  "Enter on a focused input button activates that button",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async () => {
    const steps = await driveInFirefox({ background: BACKGROUND, pages: { "/page": PAGE } });
    assert.equal(steps.failed, undefined, steps.failed?.error);
    assert.ok(steps.done, "the extension finished: " + JSON.stringify(steps));
    assert.deepEqual({ clicked: steps["second submit"].clicked, submitted: steps["second submit"].submitted1 }, { clicked: "delete", submitted: 1 });
    assert.deepEqual({ clicked: steps.reset.clicked, submitted: steps.reset.submitted1, value: steps.reset.value }, { clicked: null, submitted: 0, value: "typed" });
    assert.deepEqual({ went: steps.button.went, submitted: steps.button.submitted2 }, { went: 1, submitted: 0 });
    // A form's only text field still submits it on Enter.
    assert.equal(steps["text field"].submitted3, 1);
  },
);
