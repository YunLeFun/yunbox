#!/usr/bin/env bash
# Packages a built YunBox.app for Sparkle: YunBox-macOS.zip plus a signed
# appcast.xml in <out-dir>. The Release workflow uploads both to the GitHub
# release; the app reads releases/latest/download/appcast.xml. The update
# notes are the version's section of docs/changelog.md and
# docs/en/changelog.md; Sparkle shows the one in the app's language.
#
#   script/sparkle_appcast.sh <YunBox.app> <tag> <out-dir>
#
# The EdDSA private key comes from SPARKLE_ED_PRIVATE_KEY (CI) or, when that
# is unset, from the login keychain (account fun.yunle.yunbox, created with
# Sparkle's generate_keys). SPARKLE_DOWNLOAD_URL_PREFIX overrides where the
# appcast says the zip lives, and SPARKLE_NOTES_VERSION=unreleased takes the
# pending notes (both for local testing).
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: $0 <YunBox.app> <tag> <out-dir>" >&2
  exit 2
fi
APP="$1"
TAG="$2"
OUT_DIR="$3"
NOTES_VERSION="${SPARKLE_NOTES_VERSION:-${TAG#v}}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOSITORY="https://github.com/YunLeFun/yunbox"
SPARKLE_BIN="$ROOT_DIR/apps/macos/.build/artifacts/sparkle/Sparkle/bin"
KEY_ACCOUNT=fun.yunle.yunbox
ARCHIVE=YunBox-macOS

if [ ! -x "$SPARKLE_BIN/generate_appcast" ]; then
  echo "Sparkle tools not found in $SPARKLE_BIN; build the app first (script/build_and_run.sh --build)" >&2
  exit 1
fi
# Fail before packaging when the changelog has no notes for this version.
node "$ROOT_DIR/script/changelog.mjs" notes "$NOTES_VERSION" zh >/dev/null
node "$ROOT_DIR/script/changelog.mjs" notes "$NOTES_VERSION" en >/dev/null
if [ -e "$OUT_DIR" ] && [ -n "$(ls -A "$OUT_DIR")" ]; then
  echo "$OUT_DIR must be empty: generate_appcast turns every archive in it into an update" >&2
  exit 1
fi
mkdir -p "$OUT_DIR"

# Only the app goes in the zip, so Sparkle and Finder extract the same thing.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT_DIR/$ARCHIVE.zip"

key_args() {
  if [ -n "${SPARKLE_ED_PRIVATE_KEY:-}" ]; then echo --ed-key-file -; else echo --account "$KEY_ACCOUNT"; fi
}
with_key() {
  # The key travels on standard input, never on the command line.
  if [ -n "${SPARKLE_ED_PRIVATE_KEY:-}" ]; then printf '%s' "$SPARKLE_ED_PRIVATE_KEY" | "$@"; else "$@"; fi
}

# shellcheck disable=SC2046
with_key "$SPARKLE_BIN/generate_appcast" $(key_args) \
  --download-url-prefix "${SPARKLE_DOWNLOAD_URL_PREFIX:-$REPOSITORY/releases/download/$TAG/}" \
  --full-release-notes-url "https://yunlefun.github.io/yunbox/changelog" \
  --link "$REPOSITORY/releases" \
  --maximum-deltas 0 \
  -o "$OUT_DIR/appcast.xml" \
  "$OUT_DIR"
# generate_appcast embeds one language at most, so the notes go in afterwards,
# one <description xml:lang> per language. The app's SURequireSignedFeed needs
# the whole feed, notes included, signed: sign it again.
node "$ROOT_DIR/script/changelog.mjs" appcast "$OUT_DIR/appcast.xml" "$NOTES_VERSION"
# shellcheck disable=SC2046
with_key "$SPARKLE_BIN/sign_update" $(key_args) "$OUT_DIR/appcast.xml"

# The appcast must check out against the key that signed it ...
# shellcheck disable=SC2046
with_key "$SPARKLE_BIN/sign_update" --verify $(key_args) "$OUT_DIR/appcast.xml"
# ... and the zip against the public key the shipped app trusts. A secret that
# does not match SUPublicEDKey would publish updates nobody can install.
PUBLIC_KEY="$(/usr/libexec/PlistBuddy -c 'Print SUPublicEDKey' "$APP/Contents/Info.plist")"
SIGNATURE="$(sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p' "$OUT_DIR/appcast.xml" | head -n 1)"
swift "$ROOT_DIR/script/verify_ed_signature.swift" "$PUBLIC_KEY" "$SIGNATURE" "$OUT_DIR/$ARCHIVE.zip"
echo "$OUT_DIR/appcast.xml"
