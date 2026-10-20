#!/usr/bin/env bash
# Notarizes a Developer ID signed YunBox.app (script/build_and_run.sh with
# YUNBOX_CODESIGN_IDENTITY) and staples the ticket to it, so Gatekeeper opens
# the app without asking, even offline. Run it before script/sparkle_appcast.sh:
# the zip Sparkle signs must hold the stapled app.
#
#   script/notarize.sh <YunBox.app>
#
# Credentials, never on the command line:
# - CI: an App Store Connect API key, from APPLE_API_KEY_ID, APPLE_API_ISSUER_ID
#   and APPLE_API_KEY (the .p8 file's contents).
# - Locally: a notarytool keychain profile, NOTARY_KEYCHAIN_PROFILE (default
#   yunbox-notary), created once with
#   xcrun notarytool store-credentials yunbox-notary --apple-id <Apple ID> --team-id <team ID>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <YunBox.app>" >&2
  exit 2
fi
APP="$1"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Notarization rejects ad-hoc signatures; say so before uploading.
if codesign --display --verbose=2 "$APP" 2>&1 | grep -q '^Signature=adhoc'; then
  echo "$APP is ad-hoc signed: build it with YUNBOX_CODESIGN_IDENTITY set to a Developer ID Application certificate" >&2
  exit 1
fi

if [ -n "${APPLE_API_KEY:-}" ]; then
  : "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID is not set}" "${APPLE_API_ISSUER_ID:?APPLE_API_ISSUER_ID is not set}"
  (umask 077 && printf '%s\n' "$APPLE_API_KEY" > "$WORK_DIR/AuthKey.p8")
  AUTH=(--key "$WORK_DIR/AuthKey.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID")
else
  AUTH=(--keychain-profile "${NOTARY_KEYCHAIN_PROFILE:-yunbox-notary}")
fi

ditto -c -k --sequesterRsrc --keepParent "$APP" "$WORK_DIR/YunBox.zip"
# --wait returns 0 even when Apple rejects the app, so read the status.
xcrun notarytool submit "$WORK_DIR/YunBox.zip" "${AUTH[@]}" --wait --timeout 30m --output-format json > "$WORK_DIR/result.json"
STATUS="$(node -p 'require(process.argv[1]).status' "$WORK_DIR/result.json")"
SUBMISSION="$(node -p 'require(process.argv[1]).id' "$WORK_DIR/result.json")"
if [ "$STATUS" != Accepted ]; then
  echo "Notarization finished with status $STATUS (submission $SUBMISSION); Apple's log:" >&2
  xcrun notarytool log "$SUBMISSION" "${AUTH[@]}" >&2 || true
  exit 1
fi

xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
# What Gatekeeper decides for a downloaded copy: "source=Notarized Developer ID".
spctl --assess --type execute --verbose=2 "$APP"
