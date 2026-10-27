import { ENV_PREFIX } from "../name.js";
import type { AmoCredentials } from "../types.js";

/**
 * AMO API credentials, from the first place that has any: the --amo-key/--amo-secret
 * flags, the <ENV_PREFIX>_AMO_KEY/_SECRET environment variables, web-ext's
 * WEB_EXT_API_KEY/_SECRET, then the config file. Key and secret always come from the
 * same place; a place holding only one of them is an error, never paired with the
 * other half from somewhere else, since that would sign as the wrong account.
 */
export function resolveAmoCredentials(
  flag: Partial<AmoCredentials>,
  config: Partial<AmoCredentials>,
): AmoCredentials | undefined {
  const sources: Array<{ key?: unknown; secret?: unknown; keyName: string; secretName: string }> = [
    { key: flag.key, secret: flag.secret, keyName: "--amo-key", secretName: "--amo-secret" },
    {
      key: process.env[`${ENV_PREFIX}_AMO_KEY`],
      secret: process.env[`${ENV_PREFIX}_AMO_SECRET`],
      keyName: `${ENV_PREFIX}_AMO_KEY`,
      secretName: `${ENV_PREFIX}_AMO_SECRET`,
    },
    {
      key: process.env.WEB_EXT_API_KEY,
      secret: process.env.WEB_EXT_API_SECRET,
      keyName: "WEB_EXT_API_KEY",
      secretName: "WEB_EXT_API_SECRET",
    },
    {
      key: config.key,
      secret: config.secret,
      keyName: `"amo-key" in the config file`,
      secretName: `"amo-secret" in the config file`,
    },
  ];
  for (const source of sources) {
    const key = typeof source.key === "string" ? source.key.trim() : "";
    const secret = typeof source.secret === "string" ? source.secret.trim() : "";
    if (!key && !secret) continue;
    if (key && secret) return { key, secret };
    const [have, missing] = key ? [source.keyName, source.secretName] : [source.secretName, source.keyName];
    throw new Error(
      `${have} is set but ${missing} is not. The AMO key and secret have to come from the same place.`,
    );
  }
  return undefined;
}
