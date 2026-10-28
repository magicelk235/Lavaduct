// Runs a real Firefox, headless and on a throwaway profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "lavaduct-debugger-live-"));
process.env.LAVADUCT_STATE_DIR = join(scratch, "state");
process.env.LAVADUCT_CACHE_DIR = join(scratch, "cache");
const { convert } = await import("../dist/convert.js");
const { BidiSession } = await import("../dist/firefox/bidi.js");
const { findFirefoxInstalls, selectFirefox } = await import("../dist/firefox/locate.js");
const { readDebugLog } = await import("../dist/firefox/storage.js");

const firefox = selectFirefox(findFirefoxInstalls());

// A Chrome extension that drives a tab through chrome.debugger the way Claude in
// Chrome does: callback calls checked against runtime.lastError, REPL-mode
// evaluation, mouse clicks at a point, typing, a clipped screenshot. It writes
// what it saw to storage.local, where readDebugLog finds it.
const BACKGROUND = String.raw`
const out = [];
function log(step, data) {
  out.push({ t: Date.now(), ctx: "test", msg: JSON.stringify(Object.assign({ step }, data)) });
  return chrome.storage.local.set({ __viaduct_debug_log__: out });
}
function call(fn) {
  return new Promise((resolve, reject) => fn((result) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(result))));
}
function pngSize(b64) {
  const bin = atob(b64.slice(0, 64));
  const u32 = (i) => ((bin.charCodeAt(i) << 24) | (bin.charCodeAt(i + 1) << 16) | (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3)) >>> 0;
  return [u32(16), u32(20)];
}
async function run() {
  const tab = await chrome.tabs.create({ url: PAGE });
  await new Promise((resolve) => {
    const loaded = (id, change) => {
      if (id !== tab.id || change.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(loaded);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(loaded);
  });
  const target = { tabId: tab.id };
  const events = [];
  const detached = [];
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== tab.id) return;
    if (method === "Runtime.consoleAPICalled") events.push(method + ":" + params.args.map((a) => a.value).join(" "));
    else if (method === "Network.requestWillBeSent") events.push(method + ":" + params.request.method + " " + new URL(params.request.url).pathname);
    else if (method === "Network.responseReceived") events.push(method + ":" + params.response.status);
    else events.push(method);
  });
  chrome.debugger.onDetach.addListener((source, reason) => detached.push(reason));
  await call((cb) => chrome.debugger.attach(target, "1.3", cb));
  const send = (method, params) => call((cb) => chrome.debugger.sendCommand(target, method, params, cb));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable", { maxPostDataSize: 65536 });
  const evaluate = (expression, extra) => send("Runtime.evaluate", Object.assign({ expression, returnByValue: true }, extra));
  const repl = { awaitPromise: true, replMode: true };

  await log("evaluate", { value: (await evaluate("{document.title\n}", repl)).result.value });
  const ret = (await evaluate("{return document.title\n}", repl)).exceptionDetails || {};
  await log("return", { className: ret.exception && ret.exception.className, description: ret.exception && ret.exception.description, stack: !!ret.stackTrace, scriptId: ret.scriptId !== undefined });
  await log("await", { value: (await evaluate("{const n = await new Promise((r) => setTimeout(() => r(20), 10));\nn * 2\n}", repl)).result.value });

  const rect = async (id) => JSON.parse((await evaluate("JSON.stringify(document.getElementById('" + id + "').getBoundingClientRect())")).result.value);
  const mouse = (type, x, y, extra) => send("Input.dispatchMouseEvent", Object.assign({ type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, extra));
  const box = await rect("b");
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  await mouse("mouseMoved", x, y, { button: "none" });
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await log("click", { value: (await evaluate("window.clicks")).result.value });

  const field = await rect("t");
  await mouse("mousePressed", field.left + 5, field.top + field.height / 2);
  await mouse("mouseReleased", field.left + 5, field.top + field.height / 2);
  await send("Input.insertText", { text: "hello!" });
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await log("type", JSON.parse((await evaluate("JSON.stringify({ value: document.getElementById('t').value, inputs: window.inputs, submitted: window.submitted })")).result.value));

  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: box.left, y: box.top, width: box.width, height: box.height, scale: 1 } });
  const dpr = (await evaluate("devicePixelRatio")).result.value;
  await log("screenshot", { size: pngSize(shot.data), expected: [box.width * dpr, box.height * dpr] });

  const missing = await new Promise((resolve) => chrome.debugger.sendCommand({ tabId: 999999 }, "Page.enable", {}, () => resolve(chrome.runtime.lastError && chrome.runtime.lastError.message)));
  await log("lastError", { value: missing });

  await evaluate("fetch('/api', { method: 'POST', body: 'x' }).then((r) => r.status)", { awaitPromise: true });
  await evaluate("console.log('from the page', 7)");
  await new Promise((r) => setTimeout(r, 500));
  await chrome.tabs.remove(tab.id);
  await new Promise((r) => setTimeout(r, 300));
  await log("events", { events, detached });
  await log("done", {});
}
run().catch((e) => log("failed", { error: String((e && e.stack) || e) }));
`;

const PAGE = `<!doctype html><title>Driven page</title>
<body style="margin:0">
<button id="b" style="position:absolute;left:20px;top:30px;width:120px;height:40px" onclick="window.clicks = (window.clicks || 0) + 1">Press</button>
<form onsubmit="window.submitted = true; return false" style="position:absolute;left:20px;top:100px">
  <input id="t" style="width:200px;height:24px">
</form>
<script>window.clicks = 0; window.inputs = 0; window.submitted = false;
document.getElementById("t").addEventListener("input", () => window.inputs++);</script>
</body>`;

test(
  "a converted extension drives a tab through chrome.debugger in Firefox",
  { skip: firefox ? false : "no Firefox install found", timeout: 240_000 },
  async (t) => {
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const server = http.createServer((req, res) => {
      if (req.url === "/api") {
        req.resume();
        res.writeHead(201, { "content-type": "text/plain" });
        res.end("made");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());

    const ext = join(scratch, "ext");
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Tab Driver", version: "1.0",
      permissions: ["debugger", "storage"],
      background: { service_worker: "sw.js" },
    }));
    writeFileSync(join(ext, "sw.js"), `const PAGE = "http://127.0.0.1:${server.address().port}/page";\n${BACKGROUND}`);
    const result = await convert({
      input: ext, output: join(scratch, "out"), platforms: "desktop", generateShim: true, force: false,
      sign: "auto", install: false, firefoxRestart: false, launch: false,
    });
    assert.ok(result.success, "the extension converts");

    const profile = join(scratch, "profile");
    mkdirSync(profile);
    const session = await BidiSession.start(firefox, profile, { headless: true });
    let steps = {};
    try {
      const id = await session.installExtension(result.stagedPath);
      for (let i = 0; i < 120 && !steps.done && !steps.failed; i++) {
        await sleep(500);
        try {
          steps = Object.fromEntries(readDebugLog(profile, id).entries.map((e) => {
            const m = JSON.parse(e.msg);
            return [m.step, m];
          }));
        } catch {
          // Firefox hasn't written the storage yet.
        }
      }
    } finally {
      await session.closeBrowser();
    }

    assert.equal(steps.failed, undefined, steps.failed?.error);
    assert.ok(steps.done, "the extension finished: " + JSON.stringify(steps));
    assert.equal(steps.evaluate.value, "Driven page");
    // Firefox words a top-level return differently; the client must still see V8's
    // compile error, which is what makes it retry inside an async function.
    assert.deepEqual(
      { className: steps.return.className, stack: steps.return.stack, scriptId: steps.return.scriptId },
      { className: "SyntaxError", stack: false, scriptId: true },
    );
    assert.match(steps.return.description, /Illegal return statement/);
    assert.equal(steps.await.value, 40);
    assert.equal(steps.click.value, 1, "one click on the button");
    assert.deepEqual({ value: steps.type.value, submitted: steps.type.submitted }, { value: "hello", submitted: true });
    assert.ok(steps.type.inputs >= 2, "the page heard input events");
    assert.deepEqual(steps.screenshot.size, steps.screenshot.expected, "a clip comes back at the page's device pixel ratio");
    assert.equal(steps.lastError.value, "Debugger is not attached to the tab with id: 999999.");
    const events = steps.events.events;
    for (const e of ["Network.requestWillBeSent:POST /api", "Network.responseReceived:201", "Network.loadingFinished", "Runtime.consoleAPICalled:from the page 7"]) {
      assert.ok(events.includes(e), `${e} in ${JSON.stringify(events)}`);
    }
    assert.deepEqual(steps.events.detached, ["target_closed"]);
  },
);
