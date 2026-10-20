#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/dist/YunBox.app"
case "$MODE" in
  run|--build|--install|--verify|--debug|--logs|--telemetry) ;;
  *) echo "usage: $0 [--build|--install|--verify|--debug|--logs|--telemetry]" >&2; exit 2 ;;
esac

if [ "$MODE" != --build ]; then pkill -x YunBox >/dev/null 2>&1 || true; fi
cd "$ROOT_DIR"
# The docs site is not part of the app.
pnpm -r --filter '!@yunbox/docs' run build
# Release packaging passes e.g. "-c release --arch arm64 --arch x86_64" for a universal binary.
read -r -a SWIFT_ARGS <<< "${YUNBOX_SWIFT_BUILD_ARGS:-}"
swift build --package-path apps/macos ${SWIFT_ARGS[@]+"${SWIFT_ARGS[@]}"}
BUILD_DIR="$(swift build --package-path apps/macos ${SWIFT_ARGS[@]+"${SWIFT_ARGS[@]}"} --show-bin-path)"
APP_VERSION="$(node -p 'require("./packages/cli/package.json").version')"
# Sparkle checks this feed and only installs archives signed with the private
# half of SUPublicEDKey (kept in the maintainer's keychain and the release
# workflow's SPARKLE_ED_PRIVATE_KEY secret). Releases attach appcast.xml.
SPARKLE_FEED_URL="https://github.com/YunLeFun/yunbox/releases/latest/download/appcast.xml"
SPARKLE_PUBLIC_KEY="25QU3ICmhEYXH+kznYXnMC/AJQGtm+IYmbExHwDB3DY="
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources/cli" "$APP_BUNDLE/Contents/Frameworks"
cp "$BUILD_DIR/YunBox" "$APP_BUNDLE/Contents/MacOS/YunBox"
# The build directory's rpaths do not exist on users' Macs; the binary finds
# Sparkle through @executable_path/../Frameworks (Package.swift).
otool -l "$APP_BUNDLE/Contents/MacOS/YunBox" | awk '/cmd LC_RPATH/ { getline; getline; print $2 }' | while read -r RPATH; do
  case "$RPATH" in "$ROOT_DIR"/*) install_name_tool -delete_rpath "$RPATH" "$APP_BUNDLE/Contents/MacOS/YunBox" 2>&1 | { grep -v 'invalidate the code signature' || true; } >&2 ;; esac
done
# ditto keeps the framework's symlinks and the signatures on its helpers.
ditto "$BUILD_DIR/Sparkle.framework" "$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
cp -R packages/cli/dist/. "$APP_BUNDLE/Contents/Resources/cli/"
# Interface strings: Simplified Chinese is the source language written in the
# code, English comes from the catalog (script/sync_strings.sh keeps it current).
xcrun xcstringstool compile apps/macos/Localization/Localizable.xcstrings --output-directory "$APP_BUNDLE/Contents/Resources"
mkdir -p "$APP_BUNDLE/Contents/Resources/zh-Hans.lproj" "$APP_BUNDLE/Contents/Resources/en.lproj"
printf '"CFBundleDisplayName" = "云匣 YunBox";\n' > "$APP_BUNDLE/Contents/Resources/zh-Hans.lproj/InfoPlist.strings"
printf '"CFBundleDisplayName" = "YunBox";\n' > "$APP_BUNDLE/Contents/Resources/en.lproj/InfoPlist.strings"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({node: process.execPath}))' "$APP_BUNDLE/Contents/Resources/runtime.json"
swift script/create_app_icon.swift assets/brand/yunbox-app-icon.svg "$ROOT_DIR/dist/AppIcon.iconset"
iconutil -c icns "$ROOT_DIR/dist/AppIcon.iconset" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
# macOS 26 reads the layered Icon Composer icon (default, dark, clear, tinted)
# from Assets.car via CFBundleIconName; AppIcon.icns above stays the fallback.
# Compiling .icon files needs Xcode 26+, so older toolchains keep only the icns.
node script/sync-app-icon.mjs --check
ACTOOL_MAJOR="$(xcrun actool --version 2>/dev/null | sed -n '/short-bundle-version/{n;s/.*<string>\([0-9]*\).*/\1/p;}')"
if [ "${ACTOOL_MAJOR:-0}" -ge 26 ]; then
  ICON_BUILD_DIR="$ROOT_DIR/dist/YunBox.icon-build"
  rm -rf "$ICON_BUILD_DIR"
  mkdir -p "$ICON_BUILD_DIR"
  xcrun actool assets/brand/YunBox.icon --compile "$ICON_BUILD_DIR" \
    --platform macosx --target-device mac --minimum-deployment-target 14.0 \
    --app-icon YunBox --output-partial-info-plist "$ICON_BUILD_DIR/partial.plist" \
    --errors --warnings --output-format human-readable-text >/dev/null
  cp "$ICON_BUILD_DIR/Assets.car" "$APP_BUNDLE/Contents/Resources/Assets.car"
  ICON_NAME_KEY='<key>CFBundleIconName</key><string>YunBox</string>'
else
  echo "warning: actool ${ACTOOL_MAJOR:-unknown} cannot compile YunBox.icon (needs Xcode 26+); using AppIcon.icns only" >&2
  ICON_NAME_KEY=''
fi
cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>YunBox</string>
  <key>CFBundleIdentifier</key><string>fun.yunle.yunbox.desktop</string>
  <key>CFBundleName</key><string>YunBox</string>
  <key>CFBundleDisplayName</key><string>云匣 YunBox</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$APP_VERSION</string>
  <key>CFBundleVersion</key><string>$APP_VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  $ICON_NAME_KEY
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDevelopmentRegion</key><string>zh-Hans</string>
  <key>CFBundleLocalizations</key><array><string>zh-Hans</string><string>en</string></array>
  <key>SUFeedURL</key><string>$SPARKLE_FEED_URL</string>
  <key>SUPublicEDKey</key><string>$SPARKLE_PUBLIC_KEY</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUVerifyUpdateBeforeExtraction</key><true/>
  <key>SURequireSignedFeed</key><true/>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>Git repository</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>LSItemContentTypes</key><array><string>public.folder</string></array>
  </dict></array>
</dict></plist>
PLIST
# Ad-hoc signed, like the Sparkle.framework SwiftPM ships. Every build has a
# different ad-hoc identity, so Sparkle trusts an update through its EdDSA
# signature and only requires the new app's own signature to be intact, which
# --deep checks here.
codesign --force --sign - "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"

if [ "$MODE" = --install ]; then
  DESTINATION="$HOME/Applications/YunBox.app"
  if [ -e "$DESTINATION" ]; then
    EXISTING_ID=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$DESTINATION/Contents/Info.plist" 2>/dev/null || true)
    if [ "$EXISTING_ID" != fun.yunle.yunbox.desktop ]; then
      echo "Refusing to replace another application at $DESTINATION" >&2
      exit 1
    fi
    rm -rf "$DESTINATION"
  fi
  mkdir -p "$HOME/Applications"
  ditto "$APP_BUNDLE" "$DESTINATION"
  APP_BUNDLE="$DESTINATION"
fi

case "$MODE" in
  --build) echo "$APP_BUNDLE" ;;
  --debug) lldb -- "$APP_BUNDLE/Contents/MacOS/YunBox" ;;
  --logs|--telemetry)
    open -n "$APP_BUNDLE"
    /usr/bin/log stream --info --style compact --predicate 'process == "YunBox"'
    ;;
  *)
    open -n "$APP_BUNDLE"
    if [ "$MODE" = --verify ] || [ "$MODE" = --install ]; then
      sleep 1
      pgrep -x YunBox >/dev/null
      echo "Running: $APP_BUNDLE"
    fi
    ;;
esac
