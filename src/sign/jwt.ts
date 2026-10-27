import { createHmac, randomUUID } from "node:crypto";

// AMO refuses tokens whose exp is more than 300 s after iat.
const TOKEN_LIFETIME_SECONDS = 300;

/**
 * HS256 token for AMO's `Authorization: JWT <token>` header. AMO checks iss, iat
 * and exp; jti only keeps two tokens minted in the same second distinct.
 */
export function amoJwt(key: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iss: key, jti: randomUUID(), iat: nowSeconds, exp: nowSeconds + TOKEN_LIFETIME_SECONDS }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
  return `${header}.${claims}.${signature}`;
}
