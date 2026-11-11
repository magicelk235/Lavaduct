// Runs a real Firefox, headless and on a throwaway profile only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { firefox, driveInFirefox, cleanUp } from "./firefox-debugger-driver.js";

after(cleanUp);

// The emulation puts its dialog and console hooks into a document through
// executeScript once webNavigation reports the commit. Firefox had run the
// page's inline scripts, and its DOMContentLoaded and load handlers, before the
// hooks landed: each alert, confirm or prompt there opened Firefox's own dialog,
// which nothing reported and which left the page waiting on a person, and the
// console calls went unheard. Each document an attached tab loads is now held
// back until its hooks are in.
const LOAD = `<!doctype html><title>Load</title>
<script>
window.answers = {};
console.log("parsing");
answers.confirm = confirm("inline confirm");
alert("inline alert");
answers.prompt = prompt("inline prompt", "default");
document.addEventListener("DOMContentLoaded", () => { answers.ready = confirm("ready confirm"); });
addEventListener("load", () => { answers.load = confirm("load confirm"); });
</script>
<iframe src="/frame"></iframe>`;
const FRAME = `<!doctype html><script>parent.answers.frame = confirm("frame confirm");</script>`;

const BACKGROUND = String.raw`
async function run() {
  const tab = await openTab(ORIGIN + "/start");
  const events = [];
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== tab.id) return;
    if (method === "Page.javascriptDialogOpening") events.push(params.type + ": " + params.message);
    else if (method === "Runtime.consoleAPICalled") events.push("console: " + params.args.map((a) => a.value).join(" "));
  });
  const { send, evaluate } = await debuggee(tab);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: ORIGIN + "/load" });
  for (let i = 0; i < 80 && events.length < 7; i++) await new Promise((r) => setTimeout(r, 100));
  await log("load", { events, answers: JSON.parse(await evaluate("JSON.stringify(window.answers)")) });
}
`;

test(
  "dialogs and console calls a page makes while it loads reach an attached client",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async () => {
    const steps = await driveInFirefox({ background: BACKGROUND, pages: { "/start": "<!doctype html><title>Start</title>", "/load": LOAD, "/frame": FRAME } });
    assert.equal(steps.failed, undefined, steps.failed?.error);
    assert.ok(steps.done, "the extension finished: " + JSON.stringify(steps));
    assert.deepEqual([...steps.load.events].sort(), [
      "alert: inline alert",
      "confirm: frame confirm",
      "confirm: inline confirm",
      "confirm: load confirm",
      "confirm: ready confirm",
      "console: parsing",
      "prompt: inline prompt",
    ]);
    assert.deepEqual(steps.load.answers, { confirm: true, prompt: "default", frame: true, ready: true, load: true });
  },
);
