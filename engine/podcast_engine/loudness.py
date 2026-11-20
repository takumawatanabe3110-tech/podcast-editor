"""ラウドネス（聞こえ方の大きさ）とトゥルーピークの測定、リミッター。

- ラウドネス：ITU-R BS.1770-4 / EBU R128 の統合ラウドネス（LUFS）。
  長い素材でもメモリを抑えるため、区切って計算する（結果は一括計算と同じ）。
- トゥルーピーク：4倍にオーバーサンプリングして測るピーク（dBTP）。MP3 などに変換した後の
  音割れの目安になる。
- リミッター：先読みで、ピークが ceiling を超える前に滑らかに音量を下げる。
"""

from __future__ import annotations

from typing import Tuple

import numpy as np
from scipy.ndimage import minimum_filter1d
from scipy.signal import resample_poly, sosfilt, sosfilt_zi

CHUNK_SEC = 10.0


# ---------------------------------------------------------------- ラウドネス


def k_weighting_sos(fs: int) -> np.ndarray:
    """BS.1770 の K 特性フィルタ（高域シェルフ＋ハイパス）。任意のサンプリングレートで作る。"""
    # 高域シェルフ（+4dB）
    G, Q, fc = 3.99984385397, 0.7071752369554193, 1681.9744509555319
    K = np.tan(np.pi * fc / fs)
    Vh = 10 ** (G / 20)
    Vb = Vh ** 0.499666774155
    a0 = 1 + K / Q + K * K
    shelf = [
        (Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0,
        1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0,
    ]
    # ハイパス（約38Hz）
    Q, fc = 0.5003270373253953, 38.13547087613982
    K = np.tan(np.pi * fc / fs)
    a0 = 1 + K / Q + K * K
    hp = [1.0, -2.0, 1.0, 1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    return np.array([shelf, hp])


def _block_energies(x: np.ndarray, fs: int) -> np.ndarray:
    """400ms の窓を 100ms ずつずらした各ブロックの、チャンネル合計の平均二乗（K特性後）。"""
    ch, n = x.shape
    hop = int(round(0.1 * fs))
    win = 4 * hop
    sos = k_weighting_sos(fs)
    # 100ms ごとの二乗和を区切りながら計算し、4つ足して 400ms にする
    nhops = n // hop
    sums = np.zeros(nhops)
    chunk = max(hop, int(CHUNK_SEC * fs) // hop * hop)
    for c in range(ch):
        zi = sosfilt_zi(sos) * 0.0
        for a in range(0, nhops * hop, chunk):
            b = min(a + chunk, nhops * hop)
            y, zi = sosfilt(sos, x[c, a:b].astype(np.float64), zi=zi)
            sums[a // hop : b // hop] += (y**2).reshape(-1, hop).sum(axis=1)
    if nhops < 4:
        return np.zeros(0)
    csum = np.concatenate(([0.0], np.cumsum(sums)))
    return (csum[4:] - csum[:-4]) / win


def integrated_loudness(x: np.ndarray, fs: int) -> float:
    """統合ラウドネス（LUFS）。x は (channels, n)。L/R/モノラルの重みは 1。"""
    z = _block_energies(np.atleast_2d(x), fs)
    if z.size == 0:
        return float("-inf")
    lk = -0.691 + 10 * np.log10(np.maximum(z, 1e-20))
    z = z[lk > -70.0]  # 絶対ゲート
    if z.size == 0:
        return float("-inf")
    rel = -0.691 + 10 * np.log10(z.mean()) - 10.0
    z = z[-0.691 + 10 * np.log10(z) > rel]  # 相対ゲート
    return float(-0.691 + 10 * np.log10(z.mean()))


# ---------------------------------------------------------------- トゥルーピーク


def _oversampled_abs_peak_per_sample(x: np.ndarray, fs: int, factor: int = 4) -> np.ndarray:
    """各サンプル位置ごとの、オーバーサンプリング後の最大の絶対値（チャンネル共通）。"""
    ch, n = x.shape
    out = np.zeros(n, dtype=np.float32)
    chunk = int(CHUNK_SEC * fs)
    pad = 64  # フィルタの端の影響を避けるのりしろ
    for a in range(0, n, chunk):
        b = min(a + chunk, n)
        lo, hi = max(0, a - pad), min(n, b + pad)
        seg = x[:, lo:hi].astype(np.float64)
        up = np.abs(resample_poly(seg, factor, 1, axis=1)).max(axis=0)
        m = up[: (hi - lo) * factor].reshape(hi - lo, factor).max(axis=1)
        out[a:b] = np.maximum(m[a - lo : b - lo], np.abs(x[:, a:b]).max(axis=0))
    return out


def true_peak_dbtp(x: np.ndarray, fs: int) -> float:
    p = float(_oversampled_abs_peak_per_sample(np.atleast_2d(x), fs).max(initial=0.0))
    return 20 * np.log10(p) if p > 0 else float("-inf")


# ---------------------------------------------------------------- リミッター


def limit(
    x: np.ndarray, fs: int, ceiling_db: float = -1.0, lookahead_ms: float = 1.5,
    release_ms: float = 50.0, true_peak: bool = True,
) -> np.ndarray:
    """ピークが ceiling_db を超えないよう音量を下げる（チャンネル共通）。音の遅れはない。

    仕組み：各サンプルで必要な音量（ceiling/ピーク）を出し、先読み時間ぶん先までの最小値を取る
    → 戻るときはリリースの速さでゆっくり → 先読み時間で移動平均して滑らかにする。
    移動平均の範囲の値はすべて、その時点で必要な音量以下なので、ピークで超えることはない。
    """
    x = np.atleast_2d(x)
    ceiling = 10 ** (ceiling_db / 20)
    peak = _oversampled_abs_peak_per_sample(x, fs) if true_peak else np.abs(x).max(axis=0)
    need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-12)).astype(np.float32)
    if need.min() >= 1.0:
        return x
    L = max(1, int(round(lookahead_ms / 1000 * fs)))
    # h[n] = min(need[n .. n+L-1])（先読み）
    h = minimum_filter1d(need, size=L, origin=-(L // 2), mode="nearest")
    # リリース：下げた音量を release_ms でゆっくり戻す（0.25ms ごとに計算）
    block = max(1, int(fs * 0.00025))
    n = len(h)
    nb = -(-n // block)
    hb = np.pad(h, (0, nb * block - n), constant_values=1.0).reshape(nb, block).min(axis=1)
    cr = np.exp(-block / (release_ms / 1000 * fs))
    r = np.empty(nb, dtype=np.float32)
    cur = 1.0
    for i, t in enumerate(hb.tolist()):
        cur = t if t < cur else t + cr * (cur - t)
        r[i] = cur
    g = np.repeat(r, block)[:n]
    # 移動平均（直前 L サンプル）
    c = np.concatenate(([0.0], np.cumsum(g, dtype=np.float64)))
    idx = np.arange(1, n + 1)
    lo = np.maximum(idx - L, 0)
    smooth = ((c[idx] - c[lo]) / (idx - lo)).astype(np.float32)
    return x * smooth


def normalize(
    x: np.ndarray, fs: int, target_lufs: float = -14.0, ceiling_dbtp: float = -1.0
) -> Tuple[np.ndarray, float, float, float]:
    """ラウドネスを target_lufs にそろえ、トゥルーピークを ceiling_dbtp 以下にする。

    戻り値：(音声, 調整前のLUFS, 調整後のLUFS, 調整後のトゥルーピーク dBTP)
    リミッターで小さくなる分は、測り直して補う（±0.05 LU に入るまで、最大6回）。
    リミッターが強くかかると「音量 +1dB でラウドネス +0.3 LU」のように効きが鈍るので、
    前回との比（割線法）で次の音量を決める。
    """
    before = integrated_loudness(x, fs)
    if not np.isfinite(before):
        return x, before, before, true_peak_dbtp(x, fs)
    gain = target_lufs - before
    prev = None  # (音量, ラウドネス)
    for _ in range(6):
        y = limit(x * np.float32(10 ** (gain / 20)), fs, ceiling_dbtp)
        after = integrated_loudness(y, fs)
        miss = target_lufs - after
        if abs(miss) <= 0.05:
            break
        slope = 1.0
        if prev is not None and abs(gain - prev[0]) > 1e-6:
            slope = float(np.clip((after - prev[1]) / (gain - prev[0]), 0.1, 1.0))
        prev = (gain, after)
        gain += min(miss / slope, 12.0)
    # 最終確認：リミッターの後もわずかに超えることがあるので、超えた分だけ全体を下げる
    tp = true_peak_dbtp(y, fs)
    if tp > ceiling_dbtp:
        y = y * np.float32(10 ** ((ceiling_dbtp - tp) / 20))
        after = integrated_loudness(y, fs)
        tp = true_peak_dbtp(y, fs)
    return y, before, after, tp
