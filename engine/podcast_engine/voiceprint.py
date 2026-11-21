"""話者の声紋（どのMCのトラックか）を判定する。

resemblyzer（GE2E、256次元）を使う。モデルは pip パッケージに同梱で、実行時にネット不要。
各トラックは「その人自身のレコーダー」なので、大きい区間ほど本人の声という前提で選ぶ。
声紋は .npz に保存（埋め込み + JSON のメタ情報）。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import audio_io

MODEL_NAME = "resemblyzer-ge2e"
MODEL_FS = 16000
FRAME_SEC = 0.5

# 実測（9/25・12/4・10/2 の実素材）：同じ人 0.95〜0.99、別人 0.82〜0.86。
# GE2E は別人でも高めに出るので、間の少し同じ人寄りにして、ゲストをMCと誤認しにくくする
THRESHOLD = 0.90

_encoder = None


def _get_encoder():
    global _encoder
    if _encoder is None:
        try:
            from resemblyzer import VoiceEncoder
        except ImportError as e:  # pragma: no cover
            raise RuntimeError("resemblyzer が未導入です: pip install -e 'engine[voiceprint]'") from e
        _encoder = VoiceEncoder("cpu", verbose=False)
    return _encoder


def _unit(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v)
    return (v / n if n > 0 else v).astype(np.float32)


def embed(audio: np.ndarray, fs: int) -> np.ndarray:
    """モノラル信号の話者埋め込み（L2正規化済み、256次元）。"""
    from resemblyzer.audio import normalize_volume

    x = np.asarray(audio, dtype=np.float32)
    if x.ndim > 1:
        x = x.mean(axis=1)
    x = audio_io.resample(x, fs, MODEL_FS).astype(np.float32)
    x = normalize_volume(x, -30, increase_only=True)  # 音量差の影響を減らす
    return _unit(_get_encoder().embed_utterance(x))


def _loud_frames(x: np.ndarray, fs: int, seconds: float) -> np.ndarray:
    """0.5秒ごとに区切り、音量の大きい順に seconds 分だけ選んで時間順につなぐ。"""
    n = int(FRAME_SEC * fs)
    k = len(x) // n
    if k == 0:
        return x
    frames = x[: k * n].reshape(k, n)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    keep = max(1, int(seconds / FRAME_SEC))
    idx = np.sort(np.argsort(rms)[::-1][:keep])
    return frames[idx].reshape(-1)


def track_embedding(
    path,
    fs_hint: Optional[int] = None,
    segments: Optional[Sequence[Tuple[float, float]]] = None,
    max_seconds: float = 120,
) -> np.ndarray:
    """トラック本人の声の埋め込み。

    segments（ファイルの秒）があればその区間だけ、なければ音量上位の 0.5 秒を使う。
    """
    x, fs = audio_io.read(path, mono=True)
    x = x.astype(np.float32)
    if segments:
        parts: List[np.ndarray] = []
        total = 0.0
        for a, b in segments:
            a = max(0.0, a)
            b = min(len(x) / fs, b)
            if b <= a:
                continue
            parts.append(x[int(a * fs) : int(b * fs)])
            total += b - a
            if total >= max_seconds:
                break
        sel = np.concatenate(parts) if parts else x
        sel = sel[: int(max_seconds * fs)]
    else:
        sel = _loud_frames(x, fs, max_seconds)
    return embed(sel, fs)


def similarity(a: np.ndarray, b: np.ndarray) -> float:
    """コサイン類似度。"""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float(a @ b / d) if d > 0 else 0.0


def identify(
    emb: np.ndarray, members: Dict[str, np.ndarray], threshold: float = THRESHOLD
) -> Tuple[Optional[str], float]:
    """いちばん近いメンバーと点数。しきい値未満なら名前は None。"""
    best, score = None, -1.0
    for name, m in members.items():
        s = similarity(emb, m)
        if s > score:
            best, score = name, s
    if best is None:
        return None, 0.0
    return (best if score >= threshold else None), score


def assign(
    track_embs: Dict[str, np.ndarray],
    members: Dict[str, np.ndarray],
    threshold: float = THRESHOLD,
) -> Dict[str, Optional[str]]:
    """トラックとメンバーを1対1で割り当てる（点数の高い組から順に確定）。余りは None。"""
    pairs = sorted(
        (
            (similarity(e, m), t, name)
            for t, e in track_embs.items()
            for name, m in members.items()
        ),
        key=lambda p: -p[0],
    )
    out: Dict[str, Optional[str]] = {t: None for t in track_embs}
    used = set()
    for s, t, name in pairs:
        if s < threshold:
            break
        if out[t] is None and name not in used:
            out[t] = name
            used.add(name)
    return out


def save_print(path, emb: np.ndarray, meta: dict) -> None:
    """声紋を .npz に保存。meta には name / source / seconds などを入れる。"""
    m = dict(meta)
    m.setdefault("created", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    m.setdefault("model", MODEL_NAME)
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as f:
        np.savez(f, emb=np.asarray(emb, dtype=np.float32), meta=np.array(json.dumps(m, ensure_ascii=False)))


def load_print(path) -> Tuple[np.ndarray, dict]:
    with np.load(str(path), allow_pickle=False) as z:
        return z["emb"].astype(np.float32), json.loads(str(z["meta"]))
