"""プリセット（番組ごとの「いつもの設定」）。

`init --preset 名前` で、同期したプロジェクトに次をまとめて当てはめる：
- 声トラック：名前、音量（声の大きさを測って target_lufs にそろえる）、ノイズ除去、エフェクト
- 編集：拍手の何秒後から使うか、最初の声を出力の何秒目に置くか
- BGM：話し始め・話の終わりを基準にした位置、音量カーブ、フェード
- BGM トラック・マスターのエフェクト、出力の設定

プリセットは JSON（リポジトリの presets/ に置く）。パスはプリセットのファイルからの相対パス。

BGM の位置の基準（anchor）
- "voice_start"：最初の声の出力時刻（edit.position）
- "voice_end"：最後の声の出力時刻（edit.output_end）
- "output_start"：出力の 0 秒
キーフレームの基準：上の2つに加えて "clip_start"（クリップ先頭、既定）と "clip_end"（クリップの終わり）
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import List, Optional

from . import audio_io
from .loudness import integrated_loudness
from .project import BgmClip, Keyframe, Project, Source

FORMAT = "podpreset"
PRESET_DIR = Path(__file__).resolve().parents[2] / "presets"


def find_preset(name_or_path: str) -> Path:
    p = Path(name_or_path)
    if p.suffix == ".json" and p.exists():
        return p
    q = PRESET_DIR / f"{name_or_path}.json"
    if q.exists():
        return q
    names = sorted(x.stem for x in PRESET_DIR.glob("*.json")) if PRESET_DIR.exists() else []
    raise FileNotFoundError(f"プリセット {name_or_path!r} が見つかりません（あるもの：{', '.join(names) or 'なし'}）")


def load_preset(name_or_path: str) -> tuple:
    path = find_preset(name_or_path)
    d = json.loads(path.read_text(encoding="utf-8"))
    if d.get("format") != FORMAT:
        raise ValueError(f"{path} はプリセットではありません（format が違います）")
    return d, path.parent


def _rel(path: Path, base: Path) -> str:
    """プロジェクトのフォルダからの相対パス（できなければ絶対パス）。"""
    try:
        return os.path.relpath(path.resolve(), base.resolve())
    except ValueError:  # 別ドライブなど
        return str(path.resolve())


def voice_loudness(project: Project, source_id: str, base_dir: Path) -> float:
    """使う区間（基準時刻）に対応する、その素材の部分のラウドネス（LUFS）。"""
    off = project.sync.offset(source_id)
    segs = project.edit.segments
    if not segs:
        return float("-inf")
    a = min(s.start for s in segs)
    b = max(s.end for s in segs)
    to_file = lambda t: t + off.offset_sec + off.drift_ppm * 1e-6 * t
    x, fs = audio_io.read(project.source_path(source_id, base_dir), max(0.0, to_file(a)), to_file(b),
                          mono=True, dtype="float32")
    return integrated_loudness(x[None, :], fs)


def apply_preset(
    project: Project, preset: dict, preset_dir: Path, base_dir: Path,
    clap_time_ref: Optional[float] = None, names_given: bool = False,
) -> List[str]:
    """プロジェクトにプリセットを当てはめる。変更内容の説明（日本語）を返す。"""
    notes: List[str] = []
    base_dir = Path(base_dir)

    # ---- 編集：拍手の直後から使う、最初の声の位置
    e = preset.get("edit", {})
    if "start_after_clap_sec" in e and clap_time_ref is not None and project.edit.segments:
        first = project.edit.segments[0]
        start = clap_time_ref + float(e["start_after_clap_sec"])
        if first.start < start < first.end:
            first.start = round(start, 6)
            notes.append(f"拍手（基準時刻 {clap_time_ref:.3f} 秒）の {e['start_after_clap_sec']} 秒後から使う")
    if "position" in e:
        project.edit.position = float(e["position"])
    if "crossfade_ms" in e:
        project.edit.crossfade_ms = float(e["crossfade_ms"])
    if "end_after_speech_sec" in e:
        project.edit.end_after_speech_sec = float(e["end_after_speech_sec"])
    if "corrections" in preset:
        project.corrections = dict(preset["corrections"])

    # ---- 声トラック
    pv = preset.get("voices", [])
    default = preset.get("default_voice", {})
    for i, v in enumerate(project.voices):
        spec = pv[i] if i < len(pv) else default
        if spec.get("name") and not names_given:
            v.name = spec["name"]
        if "denoise" in preset or "denoise" in spec:
            v.denoise = spec.get("denoise", preset.get("denoise"))
        v.effects = list(spec.get("effects", []))
        v.pan = float(spec.get("pan", 0.0))
        if "target_lufs" in spec:
            lufs = voice_loudness(project, v.source, base_dir)
            v.gain_db = round(float(spec["target_lufs"]) - lufs, 2)
            notes.append(f"{v.name}：声の大きさ {lufs:.1f} LUFS → 音量 {v.gain_db:+.1f} dB で {spec['target_lufs']} LUFS に")
        elif "gain_db" in spec:
            v.gain_db = float(spec["gain_db"])

    # ---- BGM（位置は話し始め・話の終わりから計算する）
    project.bgm = []
    for b in preset.get("bgm", []):
        sid = b["source"]
        bgm_path = preset_dir / b["path"]
        if not bgm_path.exists():
            raise FileNotFoundError(f"BGM {sid!r} のファイルが見つかりません：{bgm_path}（プリセットからの相対パスで書きます）")
        project.sources[sid] = Source(path=_rel(bgm_path, base_dir), kind="bgm")
        anchor = b.get("anchor", "output_start")
        rel_at = float(b.get("at", 0.0))
        at = project.anchor_time(anchor) + rel_at  # 今の出力時刻（キーフレームの計算と説明用）
        dur = float(b["duration"])
        kfs = []
        for k in b.get("keyframes", []):
            anc = k.get("anchor", "clip_start")
            if anc == "clip_start":
                t = float(k["t"])
            elif anc == "clip_end":
                t = dur + float(k["t"])
            else:
                t = project.anchor_time(anc) + float(k["t"]) - at
            kfs.append(Keyframe(round(t, 4), float(k["db"])))
        if at < 0:
            notes.append(f"BGM {sid}：開始が 0 秒より前（{at:.2f} 秒）になったので、頭が切れます")
        project.bgm.append(BgmClip(
            source=sid, at=round(rel_at, 4), anchor=anchor, duration=dur, offset_in=float(b.get("offset_in", 0.0)),
            gain_db=float(b.get("gain_db", 0.0)), fade_in=float(b.get("fade_in", 0.0)),
            fade_out=float(b.get("fade_out", 0.0)), fade_in_curve=float(b.get("fade_in_curve", 1.0)),
            fade_out_curve=float(b.get("fade_out_curve", 1.0)), keyframes=kfs,
        ))
        notes.append(f"BGM {sid}：出力 {at:.2f}〜{at + dur:.2f} 秒")

    # ---- トラック全体のエフェクトと出力
    if "bgm_effects" in preset:
        project.bgm_effects = list(preset["bgm_effects"])
    if "master_effects" in preset:
        project.master_effects = list(preset["master_effects"])
    for k, v in preset.get("output", {}).items():
        if not hasattr(project.output, k):
            raise ValueError(f"プリセットの output.{k} は使えない項目です")
        setattr(project.output, k, v)
    return notes
