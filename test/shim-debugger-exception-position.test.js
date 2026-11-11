import { test } from "node:test";
import assert from "node:assert/strict";
import { makePage, setup, send } from "./debugger-sandbox.js";

// DevTools positions are 0-based. SpiderMonkey's Error.lineNumber and
// columnNumber are 1-based (measured in Firefox 159: `throw new Error('e')`
// reports column 7, its stack ":1:7"), and a compile error comes from the
// compile check, which puts the code one line down inside `if (0) {`. So a
// syntax error on the first line read as line 1, and every column was one
// too far right of the call frames' columns.
//
// node's V8 gives eval errors no lineNumber or columnNumber, so this page
// reports them the way SpiderMonkey does: 1-based, within the evaluated source.
const FIREFOX_POSITIONS = `
  var __positionedEval = eval;
  eval = function (code) {
    var lines = String(code).split("\\n");
    for (var i = 0; i < lines.length; i++) {
      var at = lines[i].indexOf("a b");
      if (at >= 0) {
        var e = new SyntaxError("unexpected token: identifier");
        e.lineNumber = i + 1;
        e.columnNumber = at + 3;
        throw e;
      }
    }
    return __positionedEval(code);
  };
`;

test("exception positions are 0-based, and a compile error's line is the code's own", async () => {
  const { bg } = setup({ page: makePage({ script: FIREFOX_POSITIONS }) });
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  const where = async (expression) => {
    const d = (await send(b, 1, "Runtime.evaluate", { expression })).exceptionDetails;
    return [d.lineNumber, d.columnNumber];
  };
  // "b" is at line 0, column 2; and at line 1, column 4.
  assert.deepEqual(await where("a b"), [0, 2]);
  assert.deepEqual(await where("1;\n  a b"), [1, 4]);
  // A runtime error thrown at line 2, column 7 in SpiderMonkey's numbering.
  assert.deepEqual(await where("throw Object.assign(new Error('e'), { lineNumber: 2, columnNumber: 7 })"), [1, 6]);
});
