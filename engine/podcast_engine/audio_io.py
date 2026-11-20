"""音声ファイルの入出力とリサンプル。

元の音声は書き換えない（非破壊）。読み込みは必要な範囲だけにして、長い素材でもメモリを抑える。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import soundfile as sf
import soxr


@dataclass(frozen=True)
class AudioInfo:
    path: str
    sample_rate: int
    channels: int
    frames: int
    subtype: str  # 例: "FLOAT"（32bit float）、"PCM_24"

    @property
    def duration(self) -> float:
        return self.frames / self.sample_rate


def info(path: str | Path) -> AudioInfo:
    i = sf.info(str(path))
    return AudioInfo(str(path), int(i.samplerate), int(i.channels), int(i.frames), str(i.subtype))


def read(
    path: str | Path,
    start: float = 0.0,
    stop: Optional[float] = None,
    mono: bool = False,
    dtype: str = "float32",
) -> Tuple[np.ndarray, int]:
    """start〜stop秒を読む。mono=True なら全チャンネルの平均を返す。"""
    fs = sf.info(str(path)).samplerate
    a = max(0, int(round(start * fs)))
    b = None if stop is None else max(a, int(round(stop * fs)))
    x, fs = sf.read(str(path), start=a, stop=b, dtype=dtype, always_2d=True)
    if mono:
        return x.mean(axis=1), int(fs)
    return x, int(fs)


def resample(x: np.ndarray, fs_in: float, fs_out: float, quality: str = "VHQ") -> np.ndarray:
    """サンプリングレート変換（soxr）。fs_in == fs_out ならそのまま返す。"""
    if fs_in == fs_out:
        return x
    return soxr.resample(x, fs_in, fs_out, quality=quality)
