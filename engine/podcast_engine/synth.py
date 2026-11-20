"""テスト用の合成音声（実際の録音はリポジトリに入れないため）。

対面収録を真似て、話者ごとのマイクに「本人の声＋相手の声のかぶり＋拍手＋部屋のノイズ」を入れ、
レコーダーごとに録音開始時刻と時計の速さ（ドリフト）をずらす。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

import numpy as np
from scipy.signal import butter, sosfilt

from . import audio_io


def _speech_like(n: int, fs: int, rng: np.random.Generator) -> np.ndarray:
    """声っぽい信号：帯域制限したノイズに、音節（3〜6Hz）と発話／間の区切りをかける。"""
    sos = butter(2, [150, 4000], "bandpass", fs=fs, output="sos")
    s = sosfilt(sos, rng.standard_normal(n))
    t = np.arange(n) / fs
    env = (0.5 * (1 + np.sin(2 * np.pi * rng.uniform(3, 6) * t + rng.uniform(0, 6.28)))) ** 2
    gate = np.zeros(n)
    pos = 0
    talking = rng.random() < 0.5
    while pos < n:
        length = int(rng.uniform(0.4, 2.5) * fs)
        if talking:
            gate[pos : pos + length] = 1.0
        pos += length
        talking = not talking
    gate = np.convolve(gate, np.ones(int(0.02 * fs)) / int(0.02 * fs), mode="same")
    return s * env * gate * 0.1


def _clap(fs: int, rng: np.random.Generator) -> np.ndarray:
    n = int(0.15 * fs)
    t = np.arange(n) / fs
    return rng.standard_normal(n) * np.exp(-t / 0.012) * 0.6


def _delay(x: np.ndarray, d: float, fs: int) -> np.ndarray:
    """d 秒遅らせる（小数サンプルも周波数領域で正確に）。"""
    n = len(x)
    m = 1 << int(np.ceil(np.log2(n * 2)))
    f = np.fft.rfftfreq(m, 1 / fs)
    y = np.fft.irfft(np.fft.rfft(x, m) * np.exp(-2j * np.pi * f * d), m)[:n]
    return y


@dataclass
class SynthTrack:
    start: float  # この録音機が録音を始めた「本当の時刻」
    drift_ppm: float = 0.0  # 時計の速さの誤差
    gain: float = 1.0


def make_session(
    tracks: Sequence[SynthTrack],
    fs: int = 48000,
    duration: float = 40.0,
    clap_at: float = 8.0,
    crosstalk: float = 0.3,
    crosstalk_delay: float = 0.003,
    false_transient_at: Optional[float] = 5.0,
    seed: int = 0,
) -> List[np.ndarray]:
    """各トラックの波形を返す。時刻はすべて「本当の時刻」で指定する。

    false_transient_at: 1本目のトラックにだけ入る物音（拍手と取り違えないかの確認用）。
    """
    rng = np.random.default_rng(seed)
    total = int((duration + max(t.start for t in tracks) + 2) * fs)
    voices = [_speech_like(total, fs, rng) for _ in tracks]
    clap = np.zeros(total)
    c = _clap(fs, rng)
    i = int(clap_at * fs)
    clap[i : i + len(c)] += c[: total - i]

    out = []
    for k, tr in enumerate(tracks):
        mix = voices[k].copy()
        for j, v in enumerate(voices):
            if j != k:
                mix += crosstalk * _delay(v, crosstalk_delay, fs)
        mix += clap
        if k == 0 and false_transient_at is not None:
            knock = _clap(fs, rng) * 0.8
            a = int(false_transient_at * fs)
            mix[a : a + len(knock)] += knock
        mix += rng.standard_normal(total) * 1e-3
        # 録音開始のずれ（小数サンプルまで）
        s = tr.start
        whole = int(np.floor(s * fs))
        y = _delay(mix, -(s * fs - whole) / fs, fs)[whole:]
        # 時計の誤差：速い時計ほど 1 秒あたりのサンプルが多い
        if tr.drift_ppm:
            y = audio_io.resample(y, fs, fs * (1 + tr.drift_ppm * 1e-6))
        y = y[: int(duration * fs)]
        out.append((y * tr.gain).astype(np.float32))
    return out


def expected_offset(ref: SynthTrack, other: SynthTrack) -> float:
    """基準トラックの時刻 0 でのずれ（sync.py と同じ定義）。基準のドリフトは 0 とする。

    本当の時刻 T は、基準では T - ref.start、other では (T - other.start) * (1 + p)。
    基準の時刻 0（T = ref.start）で比べる。
    """
    assert ref.drift_ppm == 0
    return (ref.start - other.start) * (1 + other.drift_ppm * 1e-6)


def write_session(paths: Sequence[str], waves: Sequence[np.ndarray], fs: int = 48000) -> None:
    import soundfile as sf

    for p, w in zip(paths, waves):
        sf.write(p, w, fs, subtype="FLOAT")
