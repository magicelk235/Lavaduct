# Privacy Policy

Last updated: October 31, 2026

lavaduct is a command-line tool that converts Google Chrome extensions into
Firefox add-ons and installs them. This policy covers what it does, and does not
do, with your data.

## The short version

lavaduct collects no personal data. Every conversion runs on your own computer.
Nothing about the extensions you convert, and nothing about you, is sent to us.
There is nowhere to send it: the tool has no servers and no accounts.

## What runs on your computer

When you convert an extension, lavaduct reads the files you point it at and
rewrites the manifest and code for Firefox. The extension source and the
converted output stay on your machine.

When you ask it to install the result, lavaduct works with the Firefox on your
computer. It may write preferences into the Firefox profile's `user.js` (to
allow unsigned add-ons, for example), start or restart Firefox, and load the
add-on through Firefox's debugging server over a connection that never leaves
your computer. If the extension talks to a native app, lavaduct reads the app's
Chrome registration and registers the same app with Firefox for the add-on.

lavaduct keeps a little state in its own folder: a random value it uses to make
add-on IDs, a list of the add-ons it installed, signed copies of add-ons, and
AMO uploads still in progress. The README lists where that folder is. You can
delete it at any time. Your AMO API secret is read from a flag, an environment
variable or a config file, and lavaduct never writes it to disk.

## Data we collect

None. lavaduct has no analytics and no telemetry.

The compatibility code lavaduct adds to a converted add-on makes no network
requests of its own. A build made with `--debug` keeps a log inside the add-on's
storage in your Firefox profile, and lavaduct reads it from there only when you
run `--logs`.

## Network access

lavaduct works offline when you give it a local file or folder and don't sign
through AMO. It reaches the network only in these cases:

- You pass a URL instead of a local path. lavaduct downloads the extension from
  that address, or from Google's extension download service for a Chrome Web
  Store link.
- You sign through Mozilla's add-on site, AMO. This happens when you choose
  `--sign amo`, or with the default `--sign auto` once you have set up AMO
  credentials. lavaduct uploads the converted add-on to addons.mozilla.org as an
  unlisted version and downloads the signed file. `--doctor` also asks AMO
  whether your credentials work. What Mozilla does with an upload is covered by
  Mozilla's own privacy policy.
- Your own toolchain fetches something it needs, for example npm installing the
  package.

Those requests go to the address you named, or to Google, Mozilla or npm. They
carry no personal information about you, apart from your AMO API key when you
sign.

## Third parties

lavaduct collects no data, so it has none to share. The only things that leave
your computer are the requests listed above, and each one starts because you
asked for it.

## Changes

If this policy changes, the updated version will be posted here with a new date
above.

## Contact

Questions? Email support@magicelklabs.com, or open an issue at
<https://github.com/magicelk235/Lavaduct/issues>.
