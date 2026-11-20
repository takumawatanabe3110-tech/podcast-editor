from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

pytest.importorskip("df", reason="DeepFilterNet が入っていない環境ではスキップ")

from podcast_engine import denoise
from podcast_engine.project import Edit, Project, Segment, Source, Sync, Voice
from podcast_engine.render import render_voice
from podcast_engine.synth import _speech_like

FS = 48000


def _noisy_speech(seconds=12, seed=0):
    """声っぽい合成音（発話と間がある）＋ 定常ノイズ。間の位置も返す。"""
    rng = np.random.default_rng(seed)
    w = _speech_like(int(seconds * FS), FS, rng).astype(np.float32)  # ノイズなしの声
    noise = (rng.standard_normal(len(w)) * 0.003).astype(np.float32)
    frame = FS // 10
    lv = (w[: len(w) // frame * frame].reshape(-1, frame) ** 2).mean(axis=1)
    quiet = np.repeat(lv < lv.max() * 1e-4, frame)  # 声が最大より 40dB 以上小さい 100ms
    quiet = np.pad(quiet, (0, len(w) - len(quiet)))
    return (w + noise).astype(np.float32), w, quiet


def _db(x):
    return 10 * np.log10(np.mean(np.asarray(x, dtype=np.float64) ** 2) + 1e-20)


def test_deepfilternet_reduces_noise(monkeypatch):
    # 区切り処理とつなぎ目も通るように、区切りを短くする
    monkeypatch.setattr(denoise, "CHUNK_SEC", 4.0)
    monkeypatch.setattr(denoise, "OVERLAP_SEC", 0.5)
    x, _, quiet = _noisy_speech()
    y = denoise.deepfilternet(x)
    assert len(y) == len(x)
    assert quiet.sum() > FS  # 間が1秒以上ある
    assert _db(y[quiet]) < _db(x[quiet]) - 10  # 間のノイズが 10dB 以上減る
    # 合成の「声」は本物の声ではないので AI に消される。声が残るかは下の実素材のテストで確かめる


REAL = Path(__file__).resolve().parents[2] / "サンプルファイル/9-25_okadayama/2026_09_25_1.wav"


@pytest.mark.skipif(not REAL.exists(), reason="実際の収録素材（リポジトリ外）がないためスキップ")
def test_real_voice_is_kept_and_noise_reduced():
    x, fs = sf.read(str(REAL), start=300 * FS, stop=330 * FS, dtype="float32")  # 9/25 の 5:00〜5:30
    y = denoise.deepfilternet(x)
    frame = FS // 10
    lv = lambda a: 10 * np.log10((a[: len(a) // frame * frame].reshape(-1, frame) ** 2).mean(axis=1) + 1e-20)
    lx, ly = lv(x), lv(y)
    assert np.percentile(ly, 90) == pytest.approx(np.percentile(lx, 90), abs=2.0)  # 話している部分の大きさ
    assert np.percentile(ly, 5) < np.percentile(lx, 5) - 8  # 静かな部分のノイズは 8dB 以上減る


def test_cache_is_reused_and_keyed_by_settings(tmp_path, monkeypatch):
    x, _, _ = _noisy_speech(seconds=4)
    src = tmp_path / "voice.wav"
    sf.write(src, x, FS, subtype="FLOAT")
    cache = tmp_path / ".podcache"
    calls = []
    real = denoise.deepfilternet
    monkeypatch.setattr(denoise, "deepfilternet", lambda a, lim=None: calls.append(lim) or real(a, lim))

    p1 = denoise.denoised_path(src, {"method": "deepfilternet", "atten_lim_db": None}, cache)
    p2 = denoise.denoised_path(src, {"method": "deepfilternet", "atten_lim_db": None}, cache)
    assert p1 == p2 and p1.exists() and len(calls) == 1  # 2回目はキャッシュを使う
    p3 = denoise.denoised_path(src, {"method": "deepfilternet", "atten_lim_db": 12}, cache)
    assert p3 != p1 and len(calls) == 2  # 設定が変われば作り直す
    assert p1.suffix == ".flac" and sf.info(str(p1)).subtype == "PCM_24"  # 小さい形式で保存
    assert sf.info(str(p1)).frames == len(x)
    assert not list(cache.glob("*.tmp.*"))  # 作業用のファイルが残らない
    with pytest.raises(ValueError):
        denoise.denoised_path(src, {"method": "magic"}, cache)


def test_cache_keeps_float_when_over_full_scale(tmp_path, monkeypatch):
    # 32bit float の素材は 0dBFS を超えることがある。24bit だと切れるので WAV（float）で保存する
    x = np.full(FS, 0.5, dtype=np.float32)
    src = tmp_path / "loud.wav"
    sf.write(src, x, FS, subtype="FLOAT")
    monkeypatch.setattr(denoise, "deepfilternet", lambda a, lim=None: a * 3)  # 1.5 になる
    p = denoise.denoised_path(src, {"method": "deepfilternet"}, tmp_path / ".podcache")
    assert p.suffix == ".wav"
    y, _ = sf.read(str(p), dtype="float32")
    assert y.max() == pytest.approx(1.5)


def test_flac_cache_is_accurate(tmp_path, monkeypatch):
    rng = np.random.default_rng(1)
    x = (rng.standard_normal(FS) * 0.1).astype(np.float32)
    src = tmp_path / "v.wav"
    sf.write(src, x, FS, subtype="FLOAT")
    monkeypatch.setattr(denoise, "deepfilternet", lambda a, lim=None: a)  # そのまま保存して誤差を見る
    p = denoise.denoised_path(src, {"method": "deepfilternet"}, tmp_path / ".podcache")
    y, _ = sf.read(str(p), dtype="float32")
    assert np.max(np.abs(y - x)) < 2.0**-22  # 24bit の1段分以内


def test_render_uses_denoised_source(tmp_path):
    x, _, quiet = _noisy_speech(seconds=6)
    sf.write(tmp_path / "v.wav", x, FS, subtype="FLOAT")
    p = Project(
        sample_rate=FS, sources={"a": Source("v.wav")}, sync=Sync("a"),
        voices=[Voice("a", denoise={"method": "deepfilternet", "atten_lim_db": None})],
        edit=Edit(segments=[Segment(0.0, 6.0)]),
    )
    y = render_voice(p, p.voices[0], tmp_path, len(x))
    assert list((tmp_path / ".podcache").glob("v.denoise-*.flac"))
    assert _db(y[quiet]) < _db(x[quiet]) - 10
