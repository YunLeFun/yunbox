#!/usr/bin/env bash
# Keeps apps/macos/Localization/Localizable.xcstrings in step with the Swift
# sources, the way Xcode does: the compiler lists every localizable string
# (Text("…"), String(localized: …) and so on) and xcstringstool merges them
# into the catalog. Simplified Chinese is the source language; every string
# needs an English translation.
#
#   script/sync_strings.sh           update the catalog, then check it
#   script/sync_strings.sh --check   fail if the catalog is out of date or incomplete (CI)
set -euo pipefail

MODE="${1:-sync}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG="$ROOT_DIR/apps/macos/Localization/Localizable.xcstrings"
source "$ROOT_DIR/script/macos_toolchain.sh"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yunbox-strings.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# A clean build: an incremental one only lists strings of the files it recompiles.
mkdir -p "$WORK_DIR/stringsdata"
yunbox_swift build --package-path "$ROOT_DIR/apps/macos" --scratch-path "$WORK_DIR/build" \
  -Xswiftc -emit-localized-strings -Xswiftc -emit-localized-strings-path -Xswiftc "$WORK_DIR/stringsdata" >/dev/null

TARGET="$CATALOG"
if [ "$MODE" = --check ]; then
  TARGET="$WORK_DIR/Localizable.xcstrings"
  cp "$CATALOG" "$TARGET"
fi
xcrun xcstringstool sync "$TARGET" --stringsdata "$WORK_DIR"/stringsdata/*.stringsdata
if [ "$MODE" = --check ]; then
  node "$ROOT_DIR/script/check_strings.mjs" "$TARGET" "$CATALOG" \
    || { echo "Localizable.xcstrings is out of date: run script/sync_strings.sh and translate the new strings" >&2; exit 1; }
else
  node "$ROOT_DIR/script/check_strings.mjs" "$TARGET"
fi
