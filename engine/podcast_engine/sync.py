"""複数トラックの編集点合わせ（同期）。

手順（docs/PLAN.md「同期」）
1. 冒頭から拍手候補（高域で鋭く立ち上がり、すぐ減衰する音）を各トラックで検出
2. 候補どうしの組み合わせから「ずれ」の候補を作り、冒頭全体の相互相関（GCC-PHAT）で検証。
   雑談中の物音など、片方のトラックにしかない音を拍手と取り違えないため
3. 採用した拍手の周辺で GCC-PHAT を細かく計算し、1サンプル未満の精度でずれを求める
4. 終盤でもずれを測り、レコーダー間の時計の誤差（ドリフト）を ppm で求める

ずれ（offset）の定義：
    同じ音が鳴る時刻について  このトラックでの時刻 = 基準トラックでの時刻 + offset
    基準トラックの時刻 t でのずれ = offset_sec + drift_ppm * 1e-6 * t
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import numpy as np
from scipy.signal import butter, sosfilt

from . import audio_io


# ---------------------------------------------------------------- GCC-PHAT


def gcc_phat_curve(
    sig: np.ndarray, ref: np.ndarray, max_shift: int, beta: float = 1.0, interp: int = 1
) -> Tuple[np.ndarray, np.ndarray]:
    """相互相関カーブを返す。lags[k]（サンプル）だけ sig が ref より遅れているときに cc が高い。

    beta: 白色化（PHAT）の強さ。1.0 で完全な PHAT。
    interp: 相関カーブの細かさ（何倍に補間するか）。
    """
    n = 1 << int(np.ceil(np.log2(len(sig) + len(ref))))
    X = np.fft.rfft(sig, n) * np.conj(np.fft.rfft(ref, n))
    X /= np.maximum(np.abs(X), 1e-20) ** beta
    cc = np.fft.irfft(X, n * interp)
    m = min(int(max_shift) * interp, n * interp // 2 - 1)
    cc = np.concatenate((cc[-m:], cc[: m + 1])) if m > 0 else cc[:1]
    lags = np.arange(-m, m + 1) / interp
    return lags, cc


def _parabolic(cc: np.ndarray, i: int) -> float:
    if 0 < i < len(cc) - 1:
        y0, y1, y2 = cc[i - 1], cc[i], cc[i + 1]
        d = y0 - 2 * y1 + y2
        if d != 0:
            return 0.5 * (y0 - y2) / d
    return 0.0


def gcc_phat(
    sig: np.ndarray, ref: np.ndarray, max_shift: int, beta: float = 1.0, interp: int = 1,
    guard_samples: int = 96,
) -> Tuple[float, float, float]:
    """(遅れ[サンプル], ピーク値, 2番目のピークとの比) を返す。

    guard_samples: 2番目のピークを探すとき、最大ピークの前後この範囲は除外する。
    """
    lags, cc = gcc_phat_curve(sig, ref, max_shift, beta, interp)
    i = int(np.argmax(cc))
    lag = lags[i] + _parabolic(cc, i) / interp
    g = guard_samples * interp
    mask = np.ones_like(cc, dtype=bool)
    mask[max(0, i - g) : i + g + 1] = False
    second = cc[mask].max() if mask.any() else 0.0
    ratio = float(cc[i] / second) if second > 0 else float("inf")
    return float(lag), float(cc[i]), ratio


# ---------------------------------------------------------------- 拍手候補の検出


@dataclass
class Transient:
    time: float  # 秒（読み込んだ区間の先頭から）
    rise_db: float  # 直前の背景からの立ち上がり
    decay_db: float  # 100ms 後までの減衰
    level_db: float  # 区間内の最大値からの差（0 に近いほど大きい音）

    @property
    def score(self) -> float:
        return self.rise_db + 0.5 * self.decay_db + 0.3 * self.level_db


def detect_transients(
    x: np.ndarray,
    fs: int,
    highpass_hz: float = 2000.0,
    frame_ms: float = 5.0,
    min_rise_db: float = 15.0,
    min_decay_db: float = 10.0,
    min_level_db: float = -30.0,
    max_candidates: int = 12,
) -> List[Transient]:
    """拍手らしい音（高域で鋭く立ち上がり、100ms以内に減衰）を探す。"""
    sos = butter(4, highpass_hz, "highpass", fs=fs, output="sos")
    y = sosfilt(sos, np.asarray(x, dtype=np.float64))
    hop = max(1, int(fs * frame_ms / 1000))
    nfr = len(y) // hop
    if nfr < 64:
        return []
    e = (y[: nfr * hop].reshape(nfr, hop) ** 2).mean(axis=1) + 1e-20
    edb = 10 * np.log10(e)

    pre, gap, after = int(200 / frame_ms), 2, int(100 / frame_ms)
    csum = np.concatenate(([0.0], np.cumsum(e)))
    out: List[Transient] = []
    top = edb.max()
    for i in range(pre + gap, nfr - after):
        bg = (csum[i - gap] - csum[i - gap - pre]) / pre
        rise = edb[i] - 10 * np.log10(bg)
        if rise < min_rise_db:
            continue
        peak = edb[i : i + 4].max()
        decay = peak - edb[i + after]
        level = peak - top
        if decay >= min_decay_db and level >= min_level_db:
            out.append(Transient(i * hop / fs, float(rise), float(decay), float(level)))

    # 150ms 以内の重複は最もスコアの高いものだけ残す
    out.sort(key=lambda t: -t.score)
    kept: List[Transient] = []
    for t in out:
        if all(abs(t.time - k.time) > 0.15 for k in kept):
            kept.append(t)
        if len(kept) >= max_candidates:
            break
    return sorted(kept, key=lambda t: t.time)


# ---------------------------------------------------------------- 同期


@dataclass
class TrackSync:
    file: str
    is_reference: bool
    offset_sec: float  # 基準トラックの時刻 0 でのずれ
    offset_samples: float
    drift_ppm: float  # 時計の誤差。正なら時間とともにずれが増える（測れないときは 0）
    drift_points: int  # ドリフトの推定に使った測定点の数（0 なら未測定）
    confidence: float  # 相関ピークの明瞭さ（2番目のピークとの比。大きいほど確実）
    method: str  # "clap"（拍手で精密化）/ "correlation"（拍手が見つからず全体相関で決定）
    clap_time_sec: Optional[float] = None  # このトラック内の拍手の時刻
    sample_rate: int = 0


@dataclass
class SyncResult:
    reference: str
    sample_rate: int
    clap_time_ref_sec: Optional[float]
    tracks: List[TrackSync] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _load_head(path: str, seconds: float, fs_target: int) -> np.ndarray:
    x, fs = audio_io.read(path, 0.0, seconds, mono=True, dtype="float64")
    return audio_io.resample(x, fs, fs_target)


def _load_range(path: str, start: float, stop: float, fs_target: int) -> np.ndarray:
    x, fs = audio_io.read(path, start, stop, mono=True, dtype="float64")
    return audio_io.resample(x, fs, fs_target)


def _cc_value_near(lags: np.ndarray, cc: np.ndarray, lag: float, tol: float) -> Tuple[float, float]:
    """lag の ±tol サンプル内で最大の相関値とその位置。"""
    m = np.abs(lags - lag) <= tol
    if not m.any():
        return -np.inf, lag
    j = np.flatnonzero(m)[np.argmax(cc[m])]
    return float(cc[j]), float(lags[j])


def _refine(
    ref: np.ndarray, other: np.ndarray, fs: int, t_ref: float, coarse: float, before: float, after: float,
    search: float = 0.02,
) -> Tuple[float, float]:
    """基準の t_ref 付近で、ずれ coarse（秒）を精密化する。戻り値 (ずれ秒, 明瞭さ)。"""
    a = int(round((t_ref - before) * fs))
    b = int(round((t_ref + after) * fs))
    a = max(a, 0, -int(np.floor(coarse * fs)))
    b = min(b, len(ref), len(other) - int(np.ceil(coarse * fs)))
    if b - a < int(0.05 * fs):
        raise ValueError("精密化に使える重なりが短すぎます")
    shift = int(round(coarse * fs))
    pad = int(search * fs)
    oa, ob = a + shift - pad, b + shift + pad
    seg_ref = ref[a:b]
    seg_oth = other[max(oa, 0) : ob]
    lead = max(oa, 0) - oa  # other 側の先頭で足りなかった分
    # seg_oth[k] は other[a + shift - pad + lead + k]。ref[a+n] と other[a+n+lag] を比べる
    lag, _, ratio = gcc_phat(seg_oth, seg_ref, max_shift=2 * pad + 1, interp=16)
    lag_total = shift - pad + lead + lag
    return lag_total / fs, ratio


MIN_DRIFT_SPAN_SEC = 120.0


def _measure_drift(
    ref_path: str, path: str, fs: int, offset_at: float, t_at: float,
    ref_len: float, oth_len: float, window: float = 30.0, step: float = 60.0,
) -> Tuple[float, int]:
    """素材全体で step 秒ごとにずれを測り、直線の傾き（ppm）を返す。戻り値 (ppm, 使った点の数)。

    会話の相関は、相手の声のかぶり（マイク間の距離ぶんの遅れ）で数ミリ秒ぶれるため、
    1点だけでは決めない。多数の点に外れ値に強い直線（Theil-Sen）を当てはめる。
    測れた区間が MIN_DRIFT_SPAN_SEC 未満なら精度が出ないので 0 を返す。
    """
    from scipy.stats import theilslopes

    end = min(ref_len, oth_len - offset_at) - 1.0
    half = window / 2
    ts: List[float] = []
    offs: List[float] = []
    search = 0.25
    c = t_at + step
    while c + half <= end:
        if c - half + offset_at - search >= 0:
            slope = theilslopes(offs, ts)[0] if len(ts) >= 2 else 0.0
            pred = offset_at + slope * (c - t_at)
            seg_ref = _load_range(ref_path, c - half, c + half, fs)
            seg_oth = _load_range(path, c - half + pred - search, c + half + pred + search, fs)
            if np.sqrt(np.mean(seg_ref**2)) > 1e-5 and len(seg_oth) > len(seg_ref):
                # かぶりで前後数ミリ秒に山が2つでき、測るたびにどちらを拾うかが変わる。
                # 相関カーブを約10msの幅でならして1つの山にし、その中心を使う
                interp = 8
                lags, cc = gcc_phat_curve(seg_oth, seg_ref, int(2 * search * fs) + 1, interp=interp)
                width = max(3, int(0.010 * fs * interp))
                sm = np.convolve(np.abs(cc), np.hanning(width), mode="same")
                i = int(np.argmax(sm))
                lag = lags[i] + _parabolic(sm, i) / interp
                g = int(0.015 * fs * interp)
                rest = np.concatenate((sm[: max(0, i - g)], sm[i + g + 1 :]))
                ratio = float(sm[i] / rest.max()) if rest.size and rest.max() > 0 else float("inf")
                if ratio >= 1.5:
                    ts.append(c)
                    offs.append(pred - search + lag / fs)
        c += step
    if len(ts) < 3 or ts[-1] - ts[0] < MIN_DRIFT_SPAN_SEC:
        return 0.0, len(ts)
    slope = theilslopes(offs, ts)[0]
    return float(slope * 1e6), len(ts)


def sync_tracks(
    paths: Sequence[str | Path],
    reference: int = 0,
    window_sec: float = 60.0,
    max_offset_sec: float = 30.0,
    drift_window_sec: float = 60.0,
    measure_drift: bool = True,
) -> SyncResult:
    """paths の各トラックを基準トラック（reference 番目）に対して同期する。"""
    paths = [str(p) for p in paths]
    infos = [audio_io.info(p) for p in paths]
    fs = infos[reference].sample_rate
    ref_path = paths[reference]

    ref_head = _load_head(ref_path, window_sec, fs)
    ref_claps = detect_transients(ref_head, fs)

    result = SyncResult(reference=ref_path, sample_rate=fs, clap_time_ref_sec=None)
    clap_times_ref: List[float] = []

    for k, path in enumerate(paths):
        if k == reference:
            continue
        other_head = _load_head(path, window_sec + max_offset_sec, fs)
        other_claps = detect_transients(other_head, fs)

        # 冒頭全体の相関（拍手候補の検証用）。PHATを少し弱めて会話の相関も効かせる
        lags, cc = gcc_phat_curve(other_head, ref_head, int(max_offset_sec * fs), beta=0.8)

        # ずれの候補：拍手候補の組み合わせ＋全体相関の上位ピーク
        candidates: List[Tuple[float, Optional[float]]] = []  # (ずれ秒, 基準の拍手時刻)
        for r in ref_claps:
            for o in other_claps:
                d = o.time - r.time
                if abs(d) <= max_offset_sec:
                    candidates.append((d, r.time))
        order = np.argsort(cc)[::-1]
        picked: List[float] = []
        for j in order[:2000]:
            lg = lags[j]
            if all(abs(lg - p) > 0.05 * fs for p in picked):
                picked.append(lg)
            if len(picked) >= 3:
                break
        candidates += [(p / fs, None) for p in picked]

        # 各候補を全体相関の値で評価。拍手の組は ±10ms 内の相関で支持されるものだけ有効
        tol = 0.010 * fs
        best = None
        for d, tr in candidates:
            val, at = _cc_value_near(lags, cc, d * fs, tol)
            # 同じずれを支持する拍手の組が多いほど加点（複数回の拍手に対応）
            support = sum(
                1 for r in ref_claps for o in other_claps if abs((o.time - r.time) - at / fs) < 0.010
            )
            key = (val * (1.0 + 0.1 * support), tr is not None)
            if best is None or key > best[0]:
                best = (key, at / fs, tr)
        assert best is not None
        _, coarse, _ = best

        # 決めたずれと一致する組のうち、最も拍手らしい（両トラックのスコア合計が高い）ものを使う。
        # 小さな物音の組も同じずれになり得るので、先に見つかった組を使うのではなく比べて選ぶ
        clap_ref = None
        best_score = -np.inf
        for r in ref_claps:
            for o in other_claps:
                if abs((o.time - r.time) - coarse) < 0.010 and r.score + o.score > best_score:
                    best_score, clap_ref = r.score + o.score, r.time

        if clap_ref is not None:
            offset_at, ratio = _refine(ref_head, other_head, fs, clap_ref, coarse, 0.05, 0.25)
            method, t_at = "clap", clap_ref
            clap_times_ref.append(clap_ref)
        else:
            t_mid = min(window_sec, len(ref_head) / fs) / 2
            offset_at, ratio = _refine(ref_head, other_head, fs, t_mid, coarse, t_mid, t_mid)
            method, t_at = "correlation", t_mid

        drift_ppm, drift_points = 0.0, 0
        if measure_drift:
            drift_ppm, drift_points = _measure_drift(
                ref_path, path, fs, offset_at, t_at,
                infos[reference].duration, infos[k].duration,
                window=drift_window_sec / 2, step=drift_window_sec,
            )

        offset0 = offset_at - drift_ppm * 1e-6 * t_at
        result.tracks.append(
            TrackSync(
                file=path,
                is_reference=False,
                offset_sec=float(offset0),
                offset_samples=float(offset0 * fs),
                drift_ppm=float(drift_ppm),
                drift_points=int(drift_points),
                confidence=float(ratio),
                method=method,
                clap_time_sec=None if clap_ref is None else float(clap_ref + offset_at),
                sample_rate=infos[k].sample_rate,
            )
        )

    if clap_times_ref:
        result.clap_time_ref_sec = float(np.median(clap_times_ref))
    result.tracks.insert(
        reference,
        TrackSync(
            file=ref_path, is_reference=True, offset_sec=0.0, offset_samples=0.0, drift_ppm=0.0,
            drift_points=0, confidence=float("inf"), method="reference", clap_time_sec=result.clap_time_ref_sec,
            sample_rate=fs,
        ),
    )
    return result
