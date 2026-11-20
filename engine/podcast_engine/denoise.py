"""ノイズ除去（DeepFilterNet）。

声の素材ファイル全体に一度かけて、結果を .podcache/ に保存して使い回す（重い処理のため）。
素材ファイル（パス・サイズ・更新時刻）か設定が変わったときだけ、処理し直す。

.podproj では声トラックごとに書く：
    "denoise": {"method": "deepfilternet", "atten_lim_db": null}
      atten_lim_db：ノイズを最大何dB下げるか。null は制限なし（「強」、9/25 の聴き比べで採用）

DeepFilterNet は PyTorch が必要（`pip install -e "engine[denoise]"`）。48kHz で動く。
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from . import audio_io

MODEL_FS = 48000
CHUNK_SEC = 60.0  # 長い素材は区切って処理する（メモリ対策）
OVERLAP_SEC = 1.0  # 区切りのつなぎ目を重ねて滑らかにする
CACHE_VERSION = 2  # 処理方法・保存形式を変えたら上げる（古いキャッシュを使わないため）

_model = None


def _load_model():
    global _model
    if _model is None:
        try:
            from df.enhance import init_df
        except ImportError as e:  # pragma: no cover
            raise RuntimeError(
                "ノイズ除去には DeepFilterNet が必要です：.venv/bin/pip install -e \"engine[denoise]\""
            ) from e
        model, state, _ = init_df(log_level="ERROR")
        _model = (model, state)
    return _model


def deepfilternet(x: np.ndarray, atten_lim_db: Optional[float] = None) -> np.ndarray:
    """48kHz モノラルの x にノイズ除去をかける。長いものは区切って処理し、重ねてつなぐ。"""
    import torch
    from df.enhance import enhance

    model, state = _load_model()
    n = len(x)
    chunk = int(CHUNK_SEC * MODEL_FS)
    ov = int(OVERLAP_SEC * MODEL_FS)
    out = np.zeros(n, dtype=np.float32)
    weight = np.zeros(n, dtype=np.float32)
    start = 0
    while start < n:
        a = max(0, start - ov)
        b = min(n, start + chunk)
        seg = torch.from_numpy(np.ascontiguousarray(x[a:b], dtype=np.float32)[None, :])
        with torch.no_grad():
            y = enhance(model, state, seg, atten_lim_db=atten_lim_db).numpy()[0].astype(np.float32)
        y = y[: b - a]
        # つなぎ目の重なり部分は直線でクロスフェード
        w = np.ones(b - a, dtype=np.float32)
        if a > 0:
            w[:ov] = np.linspace(0, 1, ov, dtype=np.float32)
        if b < n:
            w[-ov:] = np.minimum(w[-ov:], np.linspace(1, 0, ov, dtype=np.float32))
        out[a:b] += y * w
        weight[a:b] += w
        start = b
    return out / np.maximum(weight, 1e-6)


def _cache_key(path: Path, params: dict) -> str:
    st = path.stat()
    info = {
        "path": str(path.resolve()), "size": st.st_size, "mtime": st.st_mtime,
        "params": params, "version": CACHE_VERSION,
    }
    return hashlib.sha256(json.dumps(info, sort_keys=True).encode()).hexdigest()[:20]


def denoised_path(source: str | Path, params: dict, cache_dir: str | Path) -> Path:
    """ノイズ除去済みの素材ファイルのパスを返す。なければ作る（ここが重い）。

    保存形式：FLAC 24bit（可逆圧縮。32bit float の WAV の半分以下）。24bit の細かさは
    約 -144dB で、ノイズ除去後の静かな部分よりずっと細かいので音は変わらない。
    ただし 0dBFS を超える音があると 24bit では切れてしまうので、そのときだけ 32bit float の WAV。
    """
    source = Path(source)
    method = params.get("method", "deepfilternet")
    if method != "deepfilternet":
        raise ValueError(f"ノイズ除去の方法 {method!r} には対応していません（deepfilternet のみ）")
    cache_dir = Path(cache_dir)
    stem = f"{source.stem}.denoise-{_cache_key(source, params)}"
    for ext in (".flac", ".wav"):
        if (cache_dir / (stem + ext)).exists():
            return cache_dir / (stem + ext)
    cache_dir.mkdir(parents=True, exist_ok=True)
    x, fs = audio_io.read(source, mono=True, dtype="float32")
    if fs != MODEL_FS:
        x = audio_io.resample(x, fs, MODEL_FS).astype(np.float32)
    y = deepfilternet(x, params.get("atten_lim_db"))
    # 24bit の最大値（1 − 2^-23）まで収まれば FLAC
    if float(np.max(np.abs(y), initial=0.0)) <= 1.0 - 2.0**-23:
        out, subtype = cache_dir / (stem + ".flac"), "PCM_24"
    else:
        out, subtype = cache_dir / (stem + ".wav"), "FLOAT"
    tmp = out.with_name(out.stem + ".tmp" + out.suffix)
    sf.write(str(tmp), y, MODEL_FS, subtype=subtype)
    os.replace(tmp, out)  # 途中で止まっても壊れたキャッシュを残さない
    return out
