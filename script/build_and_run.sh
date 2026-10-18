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
pnpm -r run build
swift build --package-path apps/macos
BUILD_DIR="$(swift build --package-path apps/macos --show-bin-path)"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources/cli"
cp "$BUILD_DIR/YunBox" "$APP_BUNDLE/Contents/MacOS/YunBox"
cp -R packages/cli/dist/. "$APP_BUNDLE/Contents/Resources/cli/"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({node: process.execPath}))' "$APP_BUNDLE/Contents/Resources/runtime.json"
swift script/create_app_icon.swift "$ROOT_DIR/dist/AppIcon.iconset"
iconutil -c icns "$ROOT_DIR/dist/AppIcon.iconset" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
cat > "$APP_BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>YunBox</string>
  <key>CFBundleIdentifier</key><string>fun.yunle.yunbox.desktop</string>
  <key>CFBundleName</key><string>YunBox</string>
  <key>CFBundleDisplayName</key><string>云匣 YunBox</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleLocalizations</key><array><string>zh_CN</string><string>en</string></array>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>Git repository</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>LSItemContentTypes</key><array><string>public.folder</string></array>
  </dict></array>
</dict></plist>
PLIST
codesign --force --sign - "$APP_BUNDLE"
codesign --verify --strict "$APP_BUNDLE"

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
