#!/bin/bash
# 編集アプリを開く。サーバーが動いていなければ裏で起動し、ブラウザ（あれば Chrome のアプリ窓）で開く。
# 「ポッドキャスト編集.app」から呼ばれる。ターミナルから直接実行してもよい
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PODCAST_EDITOR_PORT:-8765}"
URL="http://127.0.0.1:$PORT/"
LOG="$HOME/Library/Logs/podcast-editor.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

say_error() { osascript -e "display alert \"編集アプリを開けませんでした\" message \"$1\" as critical" >/dev/null 2>&1; }
running() { curl -s -o /dev/null --max-time 1 "$URL"; }

if ! running; then
  # 画面（ui/dist）が古ければ作り直す
  if [ ! -f "$REPO/ui/dist/index.html" ] || [ -n "$(find "$REPO/ui/src" "$REPO/ui/index.html" -newer "$REPO/ui/dist/index.html" -print -quit 2>/dev/null)" ]; then
    (cd "$REPO/ui" && npm run build) >>"$LOG" 2>&1 || { say_error "画面の作成に失敗しました。記録：$LOG"; exit 1; }
  fi
  cd "$REPO/engine" || exit 1
  nohup "$REPO/.venv/bin/python" -m podcast_engine serve --no-browser --port "$PORT" >>"$LOG" 2>&1 &
  for _ in $(seq 1 60); do running && break; sleep 0.5; done
  running || { say_error "サーバーが起動しませんでした。記録：$LOG"; exit 1; }
fi

if [ -n "${PODCAST_EDITOR_NO_OPEN:-}" ]; then echo "$URL"
elif [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --new-window
else
  open "$URL"
fi
