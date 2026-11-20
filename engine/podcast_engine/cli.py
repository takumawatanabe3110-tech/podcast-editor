"""コマンドライン。

    python -m podcast_engine info  FILE...
    python -m podcast_engine sync  FILE... [--ref 0] [--out sync.json]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import List, Optional

from . import audio_io
from .sync import sync_tracks


def _clean(o):
    """JSON に入れられない inf を null にする。"""
    if isinstance(o, float) and (math.isinf(o) or math.isnan(o)):
        return None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean(v) for v in o]
    return o


def cmd_info(args) -> int:
    rows = []
    for p in args.files:
        i = audio_io.info(p)
        rows.append({**i.__dict__, "duration": i.duration})
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


def cmd_sync(args) -> int:
    r = sync_tracks(
        args.files,
        reference=args.ref,
        window_sec=args.window,
        max_offset_sec=args.max_offset,
        measure_drift=not args.no_drift,
    )
    data = _clean(r.to_dict())
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)

    # 人が読む要約は標準エラーへ（JSON を他の処理に渡せるように）
    print(f"基準: {Path(r.reference).name}", file=sys.stderr)
    for t in r.tracks:
        if t.is_reference:
            continue
        print(
            f"  {Path(t.file).name}: ずれ {t.offset_sec:+.4f} 秒"
            f"（{t.method}、明瞭さ {t.confidence:.1f}）、ドリフト {t.drift_ppm:+.1f} ppm",
            file=sys.stderr,
        )
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="podcast_engine", description="Podcast 音声処理エンジン")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("info", help="音声ファイルの形式を表示")
    p.add_argument("files", nargs="+")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("sync", help="複数トラックの編集点合わせ")
    p.add_argument("files", nargs="+")
    p.add_argument("--ref", type=int, default=0, help="基準にするトラックの番号（0始まり）")
    p.add_argument("--window", type=float, default=60.0, help="冒頭の解析に使う秒数")
    p.add_argument("--max-offset", type=float, default=30.0, help="想定する最大のずれ（秒）")
    p.add_argument("--no-drift", action="store_true", help="ドリフト（時計の誤差）を測らない")
    p.add_argument("--out", help="結果の JSON を保存するファイル")
    p.set_defaults(func=cmd_sync)

    args = ap.parse_args(argv)
    return args.func(args)
