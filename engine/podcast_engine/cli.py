"""コマンドライン。

    python -m podcast_engine info  FILE...
    python -m podcast_engine sync  FILE... [--ref 0] [--out sync.json]
    python -m podcast_engine init  FILE... --out x.podproj [--preset okadayama] [--names 青木さん 内田さん]
    python -m podcast_engine transcribe x.podproj [--trim-end 0.8]
    python -m podcast_engine cut   x.podproj START END [--output-time]
    python -m podcast_engine render x.podproj --out x.mp3
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import List, Optional

from . import audio_io
from .project import DEFAULT_DENOISE, Project, Segment, Source, Sync, TrackOffset, Voice
from .sync import sync_tracks


def parse_time(s: str) -> float:
    """"83.5" / "1:23.5" / "1:02:03" を秒にする。"""
    parts = s.split(":")
    v = 0.0
    for p in parts:
        v = v * 60 + float(p)
    return v


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


def cmd_init(args) -> int:
    """声の素材から .podproj を作る。同期を測り、全員の音がそろっている範囲を1区間にする。"""
    out = Path(args.out)
    base = out.resolve().parent
    names = args.names or []
    r = sync_tracks(args.files, reference=0)
    p = Project(name=args.name or out.stem, sample_rate=audio_io.info(args.files[0]).sample_rate)
    ids = []
    for i, f in enumerate(args.files):
        sid = f"voice{i + 1}"
        ids.append(sid)
        rel = Path(f).resolve()
        try:
            rel = rel.relative_to(base)
        except ValueError:
            pass
        p.sources[sid] = Source(path=str(rel), kind="voice")
        p.voices.append(Voice(
            source=sid, name=names[i] if i < len(names) else sid,
            denoise=None if args.no_denoise else dict(DEFAULT_DENOISE),
        ))
    p.sync = Sync(
        reference=ids[0],
        tracks={
            ids[i]: TrackOffset(t.offset_sec, t.drift_ppm, t.method)
            for i, t in enumerate(r.tracks)
            if not t.is_reference
        },
    )
    # 全トラックに音がある基準時刻の範囲
    start, end = 0.0, audio_io.info(args.files[0]).duration
    for i, t in enumerate(r.tracks):
        if t.is_reference:
            continue
        d = audio_io.info(args.files[i]).duration
        k = 1 + t.drift_ppm * 1e-6
        start = max(start, -t.offset_sec / k)
        end = min(end, (d - t.offset_sec) / k)
    p.edit.segments = [Segment(round(start, 6), round(end, 6))]

    notes = []
    if args.preset:
        from .presets import apply_preset, load_preset

        preset, preset_dir = load_preset(args.preset)
        notes = apply_preset(p, preset, preset_dir, base, r.clap_time_ref_sec, names_given=bool(names))
    if args.no_denoise:
        for v in p.voices:
            v.denoise = None
    errs = p.validate()
    if errs:
        print("プロジェクトに問題があります：\n" + "\n".join(errs), file=sys.stderr)
        return 1
    p.save(out)
    print(f"{out} を作りました（{len(ids)} トラック、出力 {p.edit.output_end:.1f} 秒まで声）", file=sys.stderr)
    for n in notes:
        print(f"  {n}", file=sys.stderr)
    return 0


def cmd_cut(args) -> int:
    p = Project.load(args.project)
    a, b = parse_time(args.start), parse_time(args.end)
    if args.output_time:
        ra, rb = p.edit.output_to_reference(a), p.edit.output_to_reference(b)
        if ra is None or rb is None:
            print("指定した出力時刻が、使っている区間の外です", file=sys.stderr)
            return 1
        a, b = ra, rb
    before = p.edit.output_end
    p.edit.cut(a, b)
    p.save(args.project)
    print(f"基準時刻 {a:.3f}〜{b:.3f} 秒をカット（全体 {before:.1f} → {p.edit.output_end:.1f} 秒）", file=sys.stderr)
    return 0


def cmd_transcribe(args) -> int:
    """文字起こしをして .transcript.json（ルビ用）と .transcript.txt（台本）を作る。話の終わりも切る。"""
    from .transcribe import transcribe_project

    proj = Path(args.project)
    p = Project.load(proj)
    base = proj.resolve().parent
    tr = transcribe_project(p, base, log=lambda s: print(s, file=sys.stderr))
    stem = proj.with_suffix("")
    tr.save(f"{stem}.transcript.json")
    Path(f"{stem}.transcript.txt").write_text(tr.script_text(), encoding="utf-8")
    n = len(tr.utterances)
    print(f"{stem}.transcript.json / .txt を作りました（発言 {n}）", file=sys.stderr)

    pad = args.trim_end if args.trim_end is not None else p.edit.end_after_speech_sec
    end = tr.speech_end
    if pad is not None and end is not None and p.edit.segments:
        last = p.edit.segments[-1]
        new_end = round(end + pad, 3)
        if last.start < new_end < last.end:
            before = p.edit.output_end
            last.end = new_end
            p.save(proj)
            print(f"話の終わり（基準時刻 {end:.2f} 秒）の {pad} 秒後で切りました"
                  f"（声の終わり {before:.1f} → {p.edit.output_end:.1f} 秒。ED の BGM もついてきます）", file=sys.stderr)
    return 0


def cmd_render(args) -> int:
    from .render import render, write

    p = Project.load(args.project)
    base = Path(args.project).resolve().parent
    audio, rep = render(p, base)
    measured = write(
        args.out, audio, rep.sample_rate, p.output.mp3_kbps,
        p.output.loudness_lufs, p.output.true_peak_dbtp,
    )
    if measured is not None:  # MP3 は書いた後に測り直した値を表示する
        rep.loudness_lufs, rep.true_peak_dbtp = measured
    msg = f"{args.out} に書き出しました（{rep.duration:.1f} 秒、ピーク {rep.peak_dbfs:+.1f} dBFS）"
    if rep.loudness_lufs is not None:
        msg += (
            f"\nラウドネス {rep.loudness_before_lufs:.1f} → {rep.loudness_lufs:.1f} LUFS、"
            f"トゥルーピーク {rep.true_peak_dbtp:.1f} dBTP"
        )
    if rep.clipped:
        msg += "\n注意：ピークが 0 dBFS を超えています（音割れ）。音量を下げてください"
    print(msg, file=sys.stderr)
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

    p = sub.add_parser("init", help="声の素材からプロジェクト（.podproj）を作る")
    p.add_argument("files", nargs="+", help="声の素材（1本目が同期の基準）")
    p.add_argument("--out", required=True, help="作る .podproj")
    p.add_argument("--names", nargs="*", help="話者名（素材の順）")
    p.add_argument("--name", help="プロジェクト名")
    p.add_argument("--no-denoise", action="store_true", help="声トラックにノイズ除去を付けない")
    p.add_argument("--preset", help="いつもの設定（presets/ のファイル名、または .json のパス）。例：okadayama")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("cut", help="区間をカットする（既定は基準時刻）")
    p.add_argument("project")
    p.add_argument("start", help="秒、または 分:秒")
    p.add_argument("end")
    p.add_argument("--output-time", action="store_true", help="時刻を完成版（出力）の時刻として扱う")
    p.set_defaults(func=cmd_cut)

    p = sub.add_parser("transcribe", help="文字起こし（台本とルビ）。話の終わりも切る")
    p.add_argument("project")
    p.add_argument("--trim-end", type=float, help="最後の言葉の何秒後で切るか（プリセットの値より優先）")
    p.set_defaults(func=cmd_transcribe)

    p = sub.add_parser("render", help="完成版を書き出す（.mp3 / .wav）")
    p.add_argument("project")
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_render)

    args = ap.parse_args(argv)
    return args.func(args)
