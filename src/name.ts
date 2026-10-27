// Every identifier derived from the tool's name comes from here, so renaming the
// tool is a change to this file and package.json. The add-on ID suffix is the
// exception in practice: once signed add-ons exist, changing it makes every
// converted add-on install as a new, separate add-on, so settle the name before
// the first public release.

/** Binary name, config file stem, state directory name and dedicated profile name. */
export const NAME = "lavaduct";

/** Prefix for environment variables, e.g. `LAVADUCT_AMO_KEY`. */
export const ENV_PREFIX = "LAVADUCT";

/** Domain part of derived add-on IDs: `<chromeId>.<salt>@<ADDON_ID_SUFFIX>`. */
export const ADDON_ID_SUFFIX = NAME;

/** Config file looked up in the working directory when --config isn't given. */
export const CONFIG_FILE = `${NAME}.config.json`;

/** Name of the Firefox profile the temporary route creates and uses by default. */
export const DEDICATED_PROFILE = NAME;
