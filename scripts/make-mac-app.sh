#!/bin/bash
# ダブルクリックで編集アプリを開く「ポッドキャスト編集.app」を ~/Applications に作る（作り直してもよい）
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/ポッドキャスト編集.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/MacOS/open-editor" <<SH
#!/bin/bash
exec "$REPO/scripts/open-editor.sh"
SH
chmod +x "$APP/Contents/MacOS/open-editor"
cat > "$APP/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>ポッドキャスト編集</string>
  <key>CFBundleIdentifier</key><string>local.podcast-editor.launcher</string>
  <key>CFBundleExecutable</key><string>open-editor</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL
# アイコン（試聴ページと同じ絵）
TMP="$(mktemp -d)"
if qlmanage -t -s 1024 -o "$TMP" "$REPO/listen/public/icon.svg" >/dev/null 2>&1; then
  SET="$TMP/icon.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$TMP/icon.svg.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$TMP/icon.svg.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/icon.icns" || true
fi
rm -rf "$TMP"
touch "$APP"
echo "作りました：$APP"
