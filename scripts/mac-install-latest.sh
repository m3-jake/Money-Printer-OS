#!/usr/bin/env bash
# One command on the Apple-silicon MacBook: update this checkout to main, build the macOS app
# (scripts/build-unified.mjs runs the full test suite first), keep the installed app as a rollback
# copy, install the new one and open it. User data (~/Library/Application Support/Money Printer OS)
# is never touched.
#
#   bash scripts/mac-install-latest.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then echo "Run this on the Apple-silicon Mac."; exit 1; fi
command -v node >/dev/null || { echo "Install Node 22 or newer first (https://nodejs.org), then run this again."; exit 1; }

git fetch origin
git checkout main
git pull --ff-only origin main
npm ci

OUTROOT="$HOME/MPO-builds"
mkdir -p "$OUTROOT"
npm run release:unified -- --out-root "$OUTROOT" --force
OUT="$(ls -td "$OUTROOT"/Unified-* | head -1)"
APP="$OUT/macOS/Money Printer OS.app"
[ -d "$APP" ] || { echo "Build output not found: $APP"; exit 1; }

DEST="/Applications/Money Printer OS.app"
[ -d "$HOME/Applications/Money Printer OS.app" ] && [ ! -d "$DEST" ] && DEST="$HOME/Applications/Money Printer OS.app"

osascript -e 'quit app "Money Printer OS"' >/dev/null 2>&1 || true
sleep 3
pkill -f "Money Printer OS.app/Contents/MacOS" >/dev/null 2>&1 || true
sleep 1

BACKUP=""
if [ -d "$DEST" ]; then BACKUP="$DEST.backup-$(date +%Y%m%d-%H%M%S)"; mv "$DEST" "$BACKUP"; fi
ditto "$APP" "$DEST"
open "$DEST"

echo "Installed $(basename "$OUT") to $DEST"
[ -n "$BACKUP" ] && echo "Rollback: quit the app, delete \"$DEST\", and rename \"$BACKUP\" back."
