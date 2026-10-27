import { test } from "node:test";
import assert from "node:assert/strict";
import { ENV_PREFIX } from "../dist/name.js";
import { resolveAmoCredentials } from "../dist/sign/credentials.js";

const OWN_KEY = `${ENV_PREFIX}_AMO_KEY`;
const OWN_SECRET = `${ENV_PREFIX}_AMO_SECRET`;
const ENV_NAMES = [OWN_KEY, OWN_SECRET, "WEB_EXT_API_KEY", "WEB_EXT_API_SECRET"];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) {
    if (vars[name] === undefined) delete process.env[name];
    else process.env[name] = vars[name];
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const flags = { key: "flag-key", secret: "flag-secret" };
const config = { key: "config-key", secret: "config-secret" };
const allEnv = {
  [OWN_KEY]: "own-key",
  [OWN_SECRET]: "own-secret",
  WEB_EXT_API_KEY: "webext-key",
  WEB_EXT_API_SECRET: "webext-secret",
};

test("credentials come from flags, then our env vars, then web-ext's, then the config file", () => {
  withEnv(allEnv, () => {
    assert.deepEqual(resolveAmoCredentials(flags, config), { key: "flag-key", secret: "flag-secret" });
    assert.deepEqual(resolveAmoCredentials({}, config), { key: "own-key", secret: "own-secret" });
  });
  withEnv({ WEB_EXT_API_KEY: "webext-key", WEB_EXT_API_SECRET: "webext-secret" }, () => {
    assert.deepEqual(resolveAmoCredentials({}, config), { key: "webext-key", secret: "webext-secret" });
  });
  withEnv({}, () => {
    assert.deepEqual(resolveAmoCredentials({}, config), { key: "config-key", secret: "config-secret" });
  });
});

test("no credentials anywhere means the AMO route is unavailable", () => {
  withEnv({ [OWN_KEY]: "", [OWN_SECRET]: "" }, () => {
    assert.equal(resolveAmoCredentials({}, {}), undefined);
  });
});

test("a key without its secret is an error instead of pairing it with a secret from elsewhere", () => {
  withEnv(allEnv, () => {
    assert.throws(() => resolveAmoCredentials({ key: "flag-key" }, config), /--amo-secret/);
  });
  withEnv({ WEB_EXT_API_SECRET: "webext-secret" }, () => {
    assert.throws(() => resolveAmoCredentials({}, config), /WEB_EXT_API_KEY/);
  });
});
