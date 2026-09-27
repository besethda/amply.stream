# Amply for Android

The listening app, installable on Android: a Trusted Web Activity that opens
https://amply.stream/app/ full-screen in the phone's own Chrome. It is the same
app as on the web, not a second one; it updates whenever the site does.

`twa-manifest.json` is the whole description of the shell. Bubblewrap
(Google's tool for these apps) generates the Android project from it.

## What it needs

- **Java 17** (Bubblewrap is particular): `brew install openjdk@17`
- **Android's command-line tools**: `brew install --cask android-commandlinetools`,
  with Google's licences accepted by the developer (`sdkmanager --licenses`)
- `~/.bubblewrap/config.json` pointing at both:
  `{"jdkPath":"/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home","androidSdkPath":"/opt/homebrew/share/android-commandlinetools"}`

## The signing key

Every version of the app must be signed with the same key, or a phone won't
install it over the last one. It lives outside this repository:

- `~/Android/amply-release.keystore` (alias `amply`)
- `~/Android/amply-keystore-password.txt`

**Back both up** (a password manager is good). Its SHA-256 fingerprint is in
`twa-manifest.json` and in `site/.well-known/assetlinks.json`, which is how
Android knows amply.stream vouches for the app and shows it without a URL bar.

## Building

    cd android
    npx @bubblewrap/cli update        # regenerate the project from twa-manifest.json
    npx @bubblewrap/cli build         # app-release-signed.apk, and an .aab for Play

For a new version, raise `appVersionCode` (and `appVersionName`) first.

## Installing on a phone

Send `app-release-signed.apk` to the phone, open it, and allow installing from
that source when Android asks.
