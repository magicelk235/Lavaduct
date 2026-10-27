# lavaduct

lavaduct converts a Chrome extension into a Firefox add-on and can install it for you. It
unpacks the extension, reports what Firefox will refuse, rewrites the manifest for
Firefox, adds a small runtime shim for the Chrome APIs Firefox lacks, and packs the
result as an `.xpi`. It then gets the add-on into Firefox in one of three ways:
signed by Mozilla through addons.mozilla.org (AMO), installed unsigned into a Firefox
build that allows it, or loaded temporarily.

It is the Firefox counterpart of [viaduct](https://github.com/magicelk235/Viaduct-CLI),
which does the same for Safari, and takes the same inputs and most of the same flags.

## Requirements

- Node.js 22.13 or newer. lavaduct has no runtime dependencies.
- macOS, Windows or Linux.
- Firefox, but only for installing. Converting and analyzing work without it.

## Install

```
npm install -g @magicelk235/lavaduct
```

To run it from a checkout instead:

```
npm install
npm run build
node dist/cli.js <input> [options]
```

`npm link` puts the `lavaduct` command on your PATH from the checkout.

## Usage

Convert an extension straight from the Chrome Web Store:

```
lavaduct "https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh"
```

This writes `./DarkReader_Firefox/` with the packed `DarkReader.xpi`, the staged
extension it was packed from, and `CONVERSION_REPORT.md`. Add `--install` to put
it into Firefox as well:

```
lavaduct "https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh" --install
```

Check an extension without converting it:

```
lavaduct ./my-extension.zip --analyze
lavaduct ./my-extension.zip --analyze --json
```

Convert several extensions in one run, each into its own `./<Name>_Firefox`:

```
lavaduct ./one.zip ./two.crx ./unpacked-dir
```

`lavaduct --help` lists every option.

## Inputs

An input can be a `.zip`, `.crx` or `.xpi` file, an unpacked extension directory,
a Chrome Web Store link, or a direct link to a `.crx` or `.zip`. lavaduct looks at the
file's first bytes rather than its name, so a CRX renamed to `.zip` still works.
For a CRX it recovers the extension's public key from the CRX header, which keeps
the extension's Chrome ID available to the rest of the conversion.

## What the conversion changes

The manifest gets a `browser_specific_settings.gecko` block with the add-on ID and
`strict_min_version`. The minimum defaults to 153.0, the current Firefox ESR, and
`--min-firefox` changes it. A background service worker becomes `background.scripts`,
because Firefox runs extension backgrounds as event pages; scripts loaded with a
literal `importScripts(...)` list are loaded ahead of the worker instead, and a
module worker keeps `"type": "module"`. `side_panel` becomes Firefox's sidebar,
closed until the user opens it. Chrome-only keys (`key`, `update_url`,
`minimum_chrome_version`) and permissions Firefox doesn't know are removed, and
`chrome-extension://` URLs in the sources become `moz-extension://`.

declarativeNetRequest rules that use conditions Firefox can't evaluate are dropped
with a warning, since Firefox would otherwise ignore them without saying so.
`externally_connectable` doesn't exist in Firefox, so web pages listed there talk
to the add-on through a small page bridge instead (`--no-oauth-bridge` turns that
off).

The shim covers `chrome.sidePanel` (on top of Firefox's sidebar), `chrome.offscreen`
(a hidden frame in the background page), `chrome.identity.getAuthToken` and its
relatives (on top of `launchWebAuthFlow`), and `chrome://favicon` URLs. It only
fills in what Firefox lacks. `--no-shim` leaves it out.

`--analyze` prints the issues and previews these manifest changes without converting
anything. Each issue is an error, a warning or info. Errors stop a conversion unless
you pass `--force`, and `--strict` makes warnings stop it too. `[auto-fixed]` marks
an issue the conversion takes care of, and `[shimmed]` one the shim works around at
runtime. `--analyze --json` prints the same findings as one JSON object with the
keys `name`, `appName`, `addonId`, `version`, `manifestVersion`, `platforms`,
`counts`, `autoFixed`, `shimmed`, `blocking`, `convertible`, `removedPermissions`,
`manifestChanges` and `issues`.

## Add-on IDs

Firefox identifies an add-on by the ID in its manifest, and on AMO an ID belongs to
whoever submits it first. Unless you pass `--addon-id`, lavaduct derives one from the
extension's Chrome Web Store ID (or a hash of its name for local inputs) and a
random salt it creates once per user, for example
`eimadpbcbfnmbkopoojfekhnkhdbieeh.1a2b3c4d@lavaduct`. You always get the same ID for the
same extension, so a new conversion updates the add-on you installed before and
keeps its data, and no one else's conversion collides with yours on AMO.

## Getting the add-on into Firefox

Release and Beta Firefox only install add-ons that Mozilla has signed. Nightly,
Developer Edition, ESR and unbranded builds let you turn that check off.
Any Firefox can load an unsigned add-on temporarily, until it quits.

`--sign` picks how lavaduct gets the add-on into Firefox. With the default, `--sign auto`,
it uses AMO when you have set AMO credentials, otherwise an unsigned install when
the Firefox it targets allows one, and otherwise a temporary install. It prints
which route it took and why. `--sign amo`, `--sign unsigned` and `--sign temporary`
force a route, and a forced route that can't work, such as `unsigned` with release
Firefox, stops with an explanation.

Without `--install`, a run ends once the `.xpi` is written, after AMO has signed it
when the amo route applies. With `--install`, lavaduct also installs it. `--firefox`
picks the Firefox (`release`, `beta`, `nightly`, `esr`, `developer-edition`, or a
path) and `--profile` the profile, by name or path. The defaults are the release
channel if it is installed, and that Firefox's default profile.

### amo

lavaduct uploads the add-on to AMO as an unlisted version, waits until Mozilla signs it,
and writes `<Name>-signed.xpi` next to the unsigned one. Unlisted means the add-on
is signed but doesn't appear on addons.mozilla.org. With `--install`, Firefox
opens the signed file and shows its install prompt, and the add-on then stays
installed like any other.

Signed files are cached, so running the same conversion again reuses the signed
file without contacting AMO. AMO never accepts a version number twice for the same
add-on, even one that was rejected or deleted, so when the contents changed but the
extension's version didn't, lavaduct adds or raises a fourth version component (1.2.3
becomes 1.2.3.1). If the version already has four parts, pass `--addon-version`.
If AMO hasn't signed the add-on within 15 minutes, lavaduct prints the status URL and
exits; running the same command again picks up where it left off. AMO allows about
ten submissions per hour, and lavaduct waits and says so when it hits that limit.

### unsigned

lavaduct writes `user_pref("xpinstall.signatures.required", false);` into the profile's
`user.js` and opens the `.xpi` in Firefox, which shows its install prompt. Firefox
reads that setting only when it starts, so if the profile is open and the setting
is new, lavaduct quits Firefox and starts it again first. With `--no-firefox-restart`
it leaves Firefox alone and tells you what is left to do.

### temporary

lavaduct starts Firefox with its remote protocol turned on and loads the staged
extension folder through it. Firefox loads a temporary add-on from where it lies,
so keep the output folder while Firefox runs; the add-on disappears when Firefox
quits. This needs Firefox 138 or newer.

By default the add-on goes into a separate `lavaduct` profile that lavaduct creates, so your
own profile never runs under remote control. While remote control is on, Firefox
marks it in the address bar. `--profile` loads it into another profile; if Firefox
has that profile open, lavaduct quits it and starts it again with remote control,
unless you pass `--no-firefox-restart`. Further temporary installs reuse a Firefox
lavaduct already started, so several add-ons can be loaded side by side.

`--headless` loads the add-on into a Firefox without a window and quits it again,
which checks that Firefox accepts the add-on. It is meant for CI.

### Checking the install

`--verify` waits up to two minutes for the add-on to show up installed and enabled
in the profile, which leaves time to accept Firefox's install prompt. `--no-launch`
doesn't start Firefox at all: the run stops once the `.xpi` is written and signed,
and you open it in Firefox yourself.

## AMO credentials

Create an API key and secret on AMO's
[API credentials page](https://addons.mozilla.org/developers/addon/api/key/), then
set them as environment variables:

```
export LAVADUCT_AMO_KEY=user:12345:67
export LAVADUCT_AMO_SECRET=...
```

lavaduct also reads web-ext's `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, the
`--amo-key` and `--amo-secret` flags, and `amo-key` and `amo-secret` in the config
file. Flags come first, then `LAVADUCT_AMO_*`, then `WEB_EXT_API_*`, then the config
file, and the key and secret always come from the same place. lavaduct never writes the
secret to disk. `lavaduct --doctor` checks the credentials against AMO.

Signing through AMO uploads the extension's code to Mozilla under your developer
account. Unlisted add-ons are signed automatically, but they still fall under
[Mozilla's add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
and can be reviewed after signing. Obfuscated or minified code may be rejected, and
a signed add-on can be disabled later. From 2026-12-01 the policies require the
source code of any machine-generated or minified code, which most Chrome Web Store
extensions contain and which lavaduct can't supply for you. Only submit extensions you
are allowed to redistribute. lavaduct prints a reminder the first time it uses AMO.

AMO also wants `data_collection_permissions` in the manifest of new add-ons. lavaduct
can't know what a third-party extension collects, so it only writes the key when
you pass `--data-collection`, for example `--data-collection none`, and otherwise
passes on AMO's warning.

As of late October 2026, AMO answers 404 when a client polls an unlisted version
for its signing status ([web-ext#3913](https://github.com/mozilla/web-ext/issues/3913)).
While that lasts, the amo route can fail to fetch a file AMO did sign; the Developer
Hub still offers it for download.

## Managing installed add-ons

`lavaduct --doctor` lists the Firefox installs it finds with their channel and version,
and whether each one can run unsigned add-ons. It also lists your profiles, marking
the default ones and those in use, and shows the Node version, whether AMO
credentials are set and work, and where lavaduct keeps its files.

`lavaduct --list` prints the add-ons in each profile of the selected Firefox, or in
`--profile`, with their ID, version and whether they are enabled. Add-ons lavaduct
installed are marked.

`lavaduct --uninstall <name or ID>` removes an add-on and its data from a profile, the
same way about:addons does. It starts a windowless Firefox for this; if Firefox has
the profile open, lavaduct quits it first and reopens it afterwards, unless you pass
`--no-firefox-restart`.

`lavaduct --logs <name or ID>` prints the log of a `--debug` build. A `--debug` build
records its shim's trace, keeping the last 2000 entries in the add-on's
`storage.local`. lavaduct reads it from the profile on disk, so Firefox can stay open.
Don't ship a `--debug` build.

## Config file

lavaduct reads `lavaduct.config.json` from the working directory, or the file `--config`
names. It holds flags keyed by their long name, and flags on the command line win:

```json
{
  "firefox": "nightly",
  "sign": "unsigned",
  "data-collection": "none",
  "install": true
}
```

On/off flags need `true` or `false`; anything else is ignored with a warning. In a
batch run, `output`, `addon-id` and `addon-version` from the config file are
ignored, since they name a single extension.

## Platforms

`--platforms desktop` is the default. `--platforms android` or `all` also writes
`browser_specific_settings.gecko_android`, which makes the add-on available to
Firefox for Android. lavaduct doesn't install onto Android devices.

On Linux, Firefox from snap or Flatpak only sees part of the file system. Snap
Firefox reads folders in your home directory that aren't hidden, and Flatpak
Firefox reads your Downloads folder. lavaduct warns when the files Firefox has to read
are somewhere else; use `--output` to put them where it can.

## Files

lavaduct keeps its per-user state (the ID salt, install records and AMO submissions) in
`~/Library/Application Support/lavaduct` on macOS, `%APPDATA%\lavaduct` on Windows and
`$XDG_CONFIG_HOME/lavaduct` on Linux. Signed files are cached in the same folder on macOS
and Windows, and in `$XDG_CACHE_HOME/lavaduct` on Linux.

## Exit codes

lavaduct exits with 0 when everything it was asked to do worked, 1 when a conversion was
blocked or failed or an install didn't happen, and 2 for invalid options. In a
batch, every input is converted on its own and the exit code is 1 if any of them
failed.

## License

Licensed under the [PolyForm Shield License 1.0.0](LICENSE). Copyright (c) 2026
Yehonatan Cohen (magicelk235).
