import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { amoJwt } from "../dist/sign/jwt.js";

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));

test("the AMO token is an HS256 JWT signed with the secret, issued by the key, valid for 300 seconds", () => {
  const token = amoJwt("user:12345:67", "0123456789abcdef", 1_800_000_000);
  const [head, body, signature] = token.split(".");

  assert.equal(signature, createHmac("sha256", "0123456789abcdef").update(`${head}.${body}`).digest("base64url"));
  assert.deepEqual(decode(head), { alg: "HS256", typ: "JWT" });
  const claims = decode(body);
  assert.equal(claims.iss, "user:12345:67");
  assert.equal(claims.iat, 1_800_000_000);
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal(typeof claims.jti, "string");
});

test("without an explicit time the token is issued now, in seconds", () => {
  const before = Math.floor(Date.now() / 1000);
  const claims = decode(amoJwt("key", "secret").split(".")[1]);
  const after = Math.floor(Date.now() / 1000);

  assert.ok(claims.iat >= before && claims.iat <= after, `iat ${claims.iat} not within [${before}, ${after}]`);
  assert.equal(claims.exp, claims.iat + 300);
});
