#!/usr/bin/env python3
"""ある月の完成版 MP3 だけを、共有用のフォルダへまとめてコピーする。

使い方：
  python3 scripts/share_month.py 岡田山ラジオ 2026-12

- コピー元：番組の「完成版のコピー先フォルダ」（program.json の deliver_dir）にある
  `番組_YYYY-MM-DD.mp3` のうち、指定した月のもの
- コピー先：program.json の share_folder_id（Google Drive のフォルダの ID。URL の
  /folders/ の後ろ）のフォルダの中に「番組M月分」（例：岡田山ラジオ12月分）を作って入れる
  - Drive のフォルダは、この Mac の Google Drive（CloudStorage の中）に見えている必要がある。
    他の人のフォルダなら、ブラウザで「ドライブにショートカットを追加」しておく
- 同じ名前のファイルがあれば上書きする。MP3 以外（.listen.json など）は入れない
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLOUD = Path.home() / "Library" / "CloudStorage"


def xattrs(path: Path) -> str:
    """フォルダの拡張属性（Drive for desktop はここに Drive の ID を書く）"""
    try:
        out = subprocess.run(["xattr", "-l", str(path)], capture_output=True).stdout
    except OSError:
        return ""
    return out.decode("utf-8", errors="replace")


def find_drive_folder(folder_id: str) -> Path | None:
    for mount in sorted(CLOUD.glob("GoogleDrive-*")):
        for dirpath, dirnames, _ in os.walk(mount, followlinks=False):
            p = Path(dirpath)
            if folder_id in xattrs(p):
                return p
            # 中身の多い隠しフォルダは見ない
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
    return None


def main() -> int:
    if len(sys.argv) != 3 or not re.fullmatch(r"\d{4}-\d{2}", sys.argv[2]):
        print("使い方：python3 scripts/share_month.py <番組> <YYYY-MM>", file=sys.stderr)
        return 2
    program, month = sys.argv[1], sys.argv[2]
    conf_path = ROOT / program / "program.json"
    conf = json.loads(conf_path.read_text(encoding="utf-8"))

    src = Path(conf.get("deliver_dir") or "")
    if not src.is_dir():
        print(f"完成版のコピー先フォルダが見つかりません：{src}", file=sys.stderr)
        return 1
    files = sorted(src.glob(f"{program}_{month}-??.mp3"))
    if not files:
        print(f"{month} の完成版 MP3 がありません（{src}）", file=sys.stderr)
        return 1

    folder_id = conf.get("share_folder_id") or ""
    parent = find_drive_folder(folder_id) if folder_id else None
    if parent is None:
        print(f"共有先のフォルダ（ID {folder_id or '未設定'}）がこの Mac の Google Drive に見えません。"
              "ブラウザで「ドライブにショートカットを追加」してください", file=sys.stderr)
        return 1

    dest = parent / f"{program}{int(month[5:])}月分"
    dest.mkdir(exist_ok=True)
    for f in files:
        tmp = dest / (f.name + ".part")
        shutil.copyfile(f, tmp)
        os.replace(tmp, dest / f.name)
        print(f"コピー：{f.name}")
    print(f"→ {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
