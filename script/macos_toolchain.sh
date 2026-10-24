#!/usr/bin/env bash
# Source from the build, test and localization entrypoints. Keep the selected
# Xcode local to this process; never change the user's global xcode-select.
YUNBOX_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YUNBOX_XCODE_VERSION="$(node -p 'require(process.argv[1]).xcodeVersion' "$YUNBOX_REPO_ROOT/apps/macos/toolchain.json")"
YUNBOX_SDK_VERSION="$(node -p 'require(process.argv[1]).sdkVersion' "$YUNBOX_REPO_ROOT/apps/macos/toolchain.json")"

YUNBOX_SELECTED_XCODE="$(xcodebuild -version 2>/dev/null | awk '$1 == "Xcode" { print $2 }' || true)"
if [ "$YUNBOX_SELECTED_XCODE" != "$YUNBOX_XCODE_VERSION" ]; then
  YUNBOX_PINNED_DEVELOPER="/Applications/Xcode_$YUNBOX_XCODE_VERSION.app/Contents/Developer"
  if [ -z "${DEVELOPER_DIR:-}" ] && [ -d "$YUNBOX_PINNED_DEVELOPER" ]; then
    export DEVELOPER_DIR="$YUNBOX_PINNED_DEVELOPER"
    YUNBOX_SELECTED_XCODE="$(xcodebuild -version | awk '$1 == "Xcode" { print $2 }')"
  fi
  if [ "$YUNBOX_SELECTED_XCODE" != "$YUNBOX_XCODE_VERSION" ]; then
    echo "YunBox requires Xcode $YUNBOX_XCODE_VERSION; select it with DEVELOPER_DIR (see apps/macos/toolchain.json)." >&2
    exit 1
  fi
fi

YUNBOX_SDK_NAME="macosx$YUNBOX_SDK_VERSION"
YUNBOX_SDK_PATH="$(xcrun --sdk "$YUNBOX_SDK_NAME" --show-sdk-path)"
YUNBOX_ACTUAL_SDK_VERSION="$(xcrun --sdk "$YUNBOX_SDK_NAME" --show-sdk-version)"
if [ "$YUNBOX_ACTUAL_SDK_VERSION" != "$YUNBOX_SDK_VERSION" ]; then
  echo "Expected macOS SDK $YUNBOX_SDK_VERSION, found $YUNBOX_ACTUAL_SDK_VERSION." >&2
  exit 1
fi
# Package.swift is the source of truth for the minimum supported system.
YUNBOX_MIN_MACOS="$(xcrun --sdk "$YUNBOX_SDK_NAME" swift package --package-path "$YUNBOX_REPO_ROOT/apps/macos" dump-package \
  | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const version = JSON.parse(input).platforms.find(p => p.platformName === "macos")?.version; if (!version) process.exit(1); process.stdout.write(version) })')"

yunbox_swift() {
  # Swift Build in Xcode 27.1 can stamp the deployment target as the SDK version
  # even with --sdk. Pass both values to the linker, using the actual SDK above.
  xcrun --sdk "$YUNBOX_SDK_NAME" swift "$@" \
    --build-system swiftbuild --sdk "$YUNBOX_SDK_PATH" \
    -Xlinker -platform_version -Xlinker macos -Xlinker "$YUNBOX_MIN_MACOS" -Xlinker "$YUNBOX_SDK_VERSION"
}
