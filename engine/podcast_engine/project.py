"""プロジェクトファイル（.podproj, JSON）。

非破壊編集：元の音声は書き換えず、同期・カット・音量・BGM の指示だけをここに持つ。
書き出し（render.py）がこの内容に沿って音声を組み立てる。

時刻の約束
- 「基準時刻」：同期の基準トラック（sync.reference）のファイル内の時刻。
  カット（edit.segments）は基準時刻で書く。文字起こしの時刻とも同じ物差しにする。
- 「出力時刻」：書き出した完成版の時刻。BGM の位置（bgm[].at）は出力時刻で書く。
- 各トラックのファイル内の時刻 = 基準時刻 + offset_sec + drift_ppm×1e-6×基準時刻
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

FORMAT = "podproj"
VERSION = 1


@dataclass
class Source:
    path: str  # .podproj からの相対パス、または絶対パス
    kind: str = "voice"  # "voice" / "bgm"


@dataclass
class TrackOffset:
    offset_sec: float = 0.0
    drift_ppm: float = 0.0
    method: str = ""


@dataclass
class Sync:
    reference: str = ""
    tracks: Dict[str, TrackOffset] = field(default_factory=dict)

    def offset(self, source_id: str) -> TrackOffset:
        if source_id == self.reference:
            return TrackOffset()
        return self.tracks.get(source_id, TrackOffset())


@dataclass
class Voice:
    source: str
    name: str = ""
    gain_db: float = 0.0
    pan: float = 0.0  # -1 左 〜 +1 右
    mute: bool = False


@dataclass
class Segment:
    start: float  # 基準時刻（秒）
    end: float

    @property
    def length(self) -> float:
        return self.end - self.start


@dataclass
class Edit:
    position: float = 0.0  # 最初の区間を置く出力時刻（OPのBGMだけ先に流す場合など）
    segments: List[Segment] = field(default_factory=list)
    crossfade_ms: float = 10.0  # 区間のつなぎ目のクロスフェード（プツッという音を防ぐ）

    def layout(self) -> List[Tuple[float, Segment]]:
        """各区間の出力時刻での開始位置。つなぎ目ではクロスフェードの分だけ重ねる。"""
        xf = self.crossfade_ms / 1000
        out, t = [], self.position
        for i, s in enumerate(self.segments):
            if i > 0:
                t -= xf
            out.append((t, s))
            t += s.length
        return out

    @property
    def output_end(self) -> float:
        lay = self.layout()
        return lay[-1][0] + lay[-1][1].length if lay else self.position

    def output_to_reference(self, t: float) -> Optional[float]:
        """出力時刻 → 基準時刻。区間の外なら None。"""
        for out_start, s in self.layout():
            if out_start <= t < out_start + s.length:
                return s.start + (t - out_start)
        return None

    def reference_to_output(self, t: float) -> Optional[float]:
        """基準時刻 → 出力時刻。カットされていれば None。"""
        for out_start, s in self.layout():
            if s.start <= t < s.end:
                return out_start + (t - s.start)
        return None

    def cut(self, start: float, end: float) -> None:
        """基準時刻の start〜end を取り除く（区間をまたいでも、途中で分割してもよい）。"""
        if end <= start:
            raise ValueError("カットの終わりは始まりより後にしてください")
        new: List[Segment] = []
        for s in self.segments:
            if end <= s.start or start >= s.end:
                new.append(s)
                continue
            if s.start < start:
                new.append(Segment(s.start, start))
            if end < s.end:
                new.append(Segment(end, s.end))
        self.segments = new


@dataclass
class Keyframe:
    t: float  # クリップ先頭からの秒
    db: float


@dataclass
class BgmClip:
    source: str
    at: float  # 出力時刻
    duration: float
    offset_in: float = 0.0  # 素材のどこから使うか（秒）
    gain_db: float = 0.0
    fade_in: float = 0.0  # 秒
    fade_out: float = 0.0  # 秒（クリップの終わりで 0 になる）
    # フェードの形。1＝直線。2 以上＝最初はゆっくり、最後に急に変わる
    # （フェードアウトの音量＝1−(経過割合)^curve。9/25 の ED は約 2）
    fade_in_curve: float = 1.0
    fade_out_curve: float = 1.0
    keyframes: List[Keyframe] = field(default_factory=list)  # gain_db に足す音量カーブ（dB）


@dataclass
class Output:
    sample_rate: int = 48000
    channels: int = 2
    mp3_kbps: int = 128


@dataclass
class Project:
    name: str = ""
    sample_rate: int = 48000  # 内部処理のサンプリングレート
    sources: Dict[str, Source] = field(default_factory=dict)
    sync: Sync = field(default_factory=Sync)
    voices: List[Voice] = field(default_factory=list)
    edit: Edit = field(default_factory=Edit)
    bgm: List[BgmClip] = field(default_factory=list)
    output: Output = field(default_factory=Output)

    # ---- 読み書き

    def to_dict(self) -> dict:
        d = asdict(self)
        return {"format": FORMAT, "version": VERSION, **d}

    @classmethod
    def from_dict(cls, d: dict) -> "Project":
        if d.get("format") != FORMAT:
            raise ValueError(".podproj ではありません（format が違います）")
        if d.get("version", 0) > VERSION:
            raise ValueError(f"新しい形式（version {d['version']}）には対応していません")
        e = d.get("edit", {})
        s = d.get("sync", {})
        return cls(
            name=d.get("name", ""),
            sample_rate=int(d.get("sample_rate", 48000)),
            sources={k: Source(**v) for k, v in d.get("sources", {}).items()},
            sync=Sync(
                reference=s.get("reference", ""),
                tracks={k: TrackOffset(**v) for k, v in s.get("tracks", {}).items()},
            ),
            voices=[Voice(**v) for v in d.get("voices", [])],
            edit=Edit(
                position=float(e.get("position", 0.0)),
                segments=[Segment(**x) for x in e.get("segments", [])],
                crossfade_ms=float(e.get("crossfade_ms", 10.0)),
            ),
            bgm=[
                BgmClip(**{**b, "keyframes": [Keyframe(**k) for k in b.get("keyframes", [])]})
                for b in d.get("bgm", [])
            ],
            output=Output(**d.get("output", {})),
        )

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> "Project":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    # ---- 便利関数

    def source_path(self, source_id: str, base_dir: str | Path) -> Path:
        p = Path(self.sources[source_id].path)
        return p if p.is_absolute() else Path(base_dir) / p

    def validate(self) -> List[str]:
        """矛盾があれば日本語のメッセージを返す（空なら問題なし）。"""
        errs = []
        for v in self.voices:
            if v.source not in self.sources:
                errs.append(f"voices: 素材 {v.source!r} が sources にありません")
        for b in self.bgm:
            if b.source not in self.sources:
                errs.append(f"bgm: 素材 {b.source!r} が sources にありません")
            if b.duration <= 0:
                errs.append(f"bgm: {b.source!r} の duration が 0 以下です")
        if self.voices and self.sync.reference not in self.sources:
            errs.append("sync.reference が sources にありません")
        xf = self.edit.crossfade_ms / 1000
        for i, s in enumerate(self.edit.segments):
            if s.length <= 0:
                errs.append(f"edit.segments[{i}]: 終わりが始まり以前です")
            elif i > 0 and s.length <= xf:
                errs.append(f"edit.segments[{i}]: クロスフェード（{self.edit.crossfade_ms}ms）より短い区間です")
        return errs
