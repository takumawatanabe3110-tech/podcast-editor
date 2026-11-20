"""エフェクト（EQ・コンプレッサー）。

.podproj では、エフェクトを辞書のリストで書く（上から順にかかる）。例：

    {"type": "eq", "bands": [
        {"type": "highpass", "freq": 104},
        {"type": "lowshelf", "freq": 176, "gain_db": 3.0},
        {"type": "bell", "freq": 3000, "gain_db": 3.0, "q": 1.0},
        {"type": "highshelf", "freq": 5000, "gain_db": 0.0}]}
    {"type": "compressor", "threshold_db": -10, "ratio": 4, "knee": 0,
     "attack_ms": 0.7, "release_ms": 93, "makeup_db": 0, "dry_mix": 0}
    {"type": "gain", "db": 3.2}          # フェーダー。並べた位置でかかる

Resolve（Fairlight）の画面の値をそのまま写せるように、項目名と単位をそろえている。
- EQ のハイパス／ローパスは 12 dB/oct（Resolve の画面のカーブから推定）
- シェルフは傾き S=1、ベルは Q を指定（RBJ の式）
- コンプのニーは Resolve の 0〜100。曲がる幅を 0〜20 dB とみなす（画面のカーブから推定）
- dry_mix は元の音を混ぜる割合（0＝全部コンプ後）。Resolve の「ミックス 0」は 0 にあたる
"""

from __future__ import annotations

from typing import Callable, Dict, List

import numpy as np
from scipy.signal import butter, sosfilt

Processor = Callable[[np.ndarray], np.ndarray]  # (channels, n) → (channels, n)


# ---------------------------------------------------------------- EQ


def _biquad(kind: str, freq: float, gain_db: float, q: float, fs: int) -> np.ndarray:
    """RBJ Audio EQ Cookbook の係数を sos 形式（1段）で返す。"""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * freq / fs
    cw, sw = np.cos(w0), np.sin(w0)
    if kind == "bell":
        alpha = sw / (2 * q)
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    elif kind in ("lowshelf", "highshelf"):
        alpha = sw / 2 * np.sqrt(2)  # 傾き S=1
        sA = 2 * np.sqrt(A) * alpha
        if kind == "lowshelf":
            b = [A * ((A + 1) - (A - 1) * cw + sA), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sA)]
            a = [(A + 1) + (A - 1) * cw + sA, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sA]
        else:
            b = [A * ((A + 1) + (A - 1) * cw + sA), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sA)]
            a = [(A + 1) - (A - 1) * cw + sA, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sA]
    else:
        raise ValueError(f"EQ の種類 {kind!r} には対応していません")
    b = np.array(b) / a[0]
    a = np.array(a) / a[0]
    return np.concatenate([b, a])[None, :]


def eq_sos(bands: List[dict], fs: int) -> np.ndarray:
    sections = []
    for band in bands:
        if not band.get("enabled", True):
            continue
        kind = band["type"]
        f = float(band["freq"])
        if kind in ("highpass", "lowpass"):
            if f >= fs / 2:
                continue
            sections.append(butter(2, f, kind, fs=fs, output="sos"))
        else:
            g = float(band.get("gain_db", 0.0))
            if g == 0.0:
                continue  # 0dB のバンドは何もしない
            sections.append(_biquad(kind, f, g, float(band.get("q", 1.0)), fs))
    return np.concatenate(sections) if sections else np.zeros((0, 6))


def make_eq(params: dict, fs: int) -> Processor:
    sos = eq_sos(params.get("bands", []), fs)

    def run(x: np.ndarray) -> np.ndarray:
        if len(sos) == 0:
            return x
        return sosfilt(sos, x, axis=-1).astype(np.float32)

    return run


# ---------------------------------------------------------------- コンプレッサー


def static_gain_db(level_db: np.ndarray, threshold_db: float, ratio: float, knee_db: float) -> np.ndarray:
    """入力レベル（dB）に対する音量の下げ幅（dB、0 以下）。ソフトニー対応。"""
    over = level_db - threshold_db
    slope = 1 / ratio - 1
    g = np.where(over > 0, slope * over, 0.0)
    if knee_db > 0:
        k = knee_db / 2
        inside = np.abs(over) <= k
        g = np.where(inside, slope * (over + k) ** 2 / (2 * knee_db), g)
    return g


def make_compressor(params: dict, fs: int) -> Processor:
    thr = float(params["threshold_db"])
    ratio = float(params["ratio"])
    knee_db = float(params.get("knee", 0)) / 100 * 20
    attack = max(float(params.get("attack_ms", 1.0)), 0.01) / 1000
    release = max(float(params.get("release_ms", 100.0)), 0.01) / 1000
    makeup = 10 ** (float(params.get("makeup_db", 0.0)) / 20)
    dry = float(params.get("dry_mix", 0.0))
    if float(params.get("hold_ms", 0.0)) != 0.0:
        raise ValueError("コンプのホールドにはまだ対応していません（0 にしてください）")

    block = max(1, int(fs * 0.00025))  # 0.25ms ごとに音量を見る
    ca = np.exp(-block / (attack * fs))
    cr = np.exp(-block / (release * fs))

    def run(x: np.ndarray) -> np.ndarray:
        n = x.shape[-1]
        nb = -(-n // block)
        pad = nb * block - n
        # ステレオはチャンネル共通の音量で判断（左右で定位がずれないように）
        peak = np.abs(np.pad(x, ((0, 0), (0, pad)))).max(axis=0).reshape(nb, block).max(axis=1)
        target = static_gain_db(20 * np.log10(np.maximum(peak, 1e-9)), thr, ratio, knee_db)
        # 下げるときはアタック、戻すときはリリースの速さで追いかける
        g = np.empty(nb)
        cur = 0.0
        for i, t in enumerate(target.tolist()):
            c = ca if t < cur else cr
            cur = t + c * (cur - t)
            g[i] = cur
        gain = 10 ** (np.repeat(g, block)[:n] / 20) * makeup
        y = x * gain.astype(np.float32)
        if dry > 0:
            y = (1 - dry) * y + dry * x
        return y.astype(np.float32)

    return run


# ---------------------------------------------------------------- 音量（フェーダー）


def make_gain(params: dict, fs: int) -> Processor:
    """音量を db だけ変える。Resolve のフェーダー（エフェクトやコンプの後）にあたる。"""
    g = np.float32(10 ** (float(params.get("db", 0.0)) / 20))

    def run(x: np.ndarray) -> np.ndarray:
        return x * g

    return run


# ---------------------------------------------------------------- まとめ

_FACTORIES: Dict[str, Callable[[dict, int], Processor]] = {
    "eq": make_eq,
    "compressor": make_compressor,
    "gain": make_gain,
}


def make_chain(effects: List[dict], fs: int) -> Processor:
    procs = []
    for e in effects:
        if not e.get("enabled", True):
            continue
        t = e.get("type")
        if t not in _FACTORIES:
            raise ValueError(f"エフェクト {t!r} には対応していません（使えるもの：{', '.join(_FACTORIES)}）")
        procs.append(_FACTORIES[t](e, fs))

    def run(x: np.ndarray) -> np.ndarray:
        for p in procs:
            x = p(x)
        return x

    return run


def validate(effects: List[dict], where: str) -> List[str]:
    errs = []
    for i, e in enumerate(effects):
        if e.get("type") not in _FACTORIES:
            errs.append(f"{where}[{i}]: エフェクト {e.get('type')!r} には対応していません")
        elif e["type"] == "compressor":
            for k in ("threshold_db", "ratio"):
                if k not in e:
                    errs.append(f"{where}[{i}]: compressor に {k} がありません")
    return errs
