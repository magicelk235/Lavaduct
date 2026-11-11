import { test } from "node:test";
import assert from "node:assert/strict";
import { plain } from "./shim-sandbox.js";
import { makePage, setup, send } from "./debugger-sandbox.js";

// DOM.describeNode's depth "defaults to 1" in the protocol, as getDocument's
// does: without one, Chrome describes the node's children too. The emulation
// read a missing depth as 0 and left them out.
const TINY_DOM = `
  function node(type, name, kids) {
    var n = { nodeType: type, nodeName: name, localName: type === 1 ? name.toLowerCase() : "", nodeValue: type === 3 ? "hi" : null,
      attributes: [], childNodes: kids || [], cloneNode: function () { return n; } };
    n.firstChild = n.childNodes[0] || null;
    n.childNodes.forEach(function (c, i) { c.nextSibling = n.childNodes[i + 1] || null; c.firstChild = c.firstChild || null; });
    return n;
  }
  document.body = node(1, "BODY", [node(1, "P", [node(3, "#text")])]);
`;

test("DOM.describeNode without a depth describes the node's children, one level down", async () => {
  const { bg } = setup({ page: makePage({ script: TINY_DOM }) });
  const b = bg.browser;
  await b.debugger.attach({ tabId: 1 });
  const body = (await send(b, 1, "Runtime.evaluate", { expression: "document.body" })).result;
  assert.equal(body.subtype, "node");

  const { node } = plain(await send(b, 1, "DOM.describeNode", { objectId: body.objectId }));
  assert.deepEqual(node.children.map((c) => c.nodeName), ["P"]);
  assert.equal(node.children[0].children, undefined, "only one level");

  const bare = plain(await send(b, 1, "DOM.describeNode", { objectId: body.objectId, depth: 0 })).node;
  assert.equal(bare.children, undefined);
  const deep = plain(await send(b, 1, "DOM.describeNode", { objectId: body.objectId, depth: -1 })).node;
  assert.equal(deep.children[0].children[0].nodeName, "#text");
});
