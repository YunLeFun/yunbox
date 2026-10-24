#!/usr/bin/env bash
# Build or test the native package with the same SDK and linker settings as releases.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  build|test) COMMAND="$1"; shift ;;
  *) echo "usage: $0 <build|test> [SwiftPM options]" >&2; exit 2 ;;
esac
source "$ROOT_DIR/script/macos_toolchain.sh"
yunbox_swift "$COMMAND" --package-path "$ROOT_DIR/apps/macos" "$@"
