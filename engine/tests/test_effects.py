import numpy as np
import pytest
from scipy.signal import sosfreqz

from podcast_engine.effects import eq_sos, make_chain, make_compressor, static_gain_db, validate

FS = 48000


def _response_db(bands, freqs):
    sos = eq_sos(bands, FS)
    _, h = sosfreqz(sos, worN=np.asarray(freqs, dtype=float), fs=FS)
    return 20 * np.log10(np.abs(h))


def test_eq_bands_match_settings():
    # 9/25 青木さんの設定
    bands = [
        {"type": "highpass", "freq": 104},
        {"type": "lowshelf", "freq": 176, "gain_db": 3.0},
        {"type": "bell", "freq": 239, "gain_db": 0.0, "q": 1.0},
        {"type": "bell", "freq": 3000, "gain_db": 3.0, "q": 1.0},
        {"type": "highshelf", "freq": 5000, "gain_db": 0.0},
    ]
    r = _response_db(bands, [26, 104, 1000, 3000, 15000])
    assert r[0] < -20  # 104Hz の2オクターブ下は 12dB/oct で約 -24dB
    assert r[1] == pytest.approx(-3 + 1.5, abs=1.5)  # 104Hz はハイパスで -3dB、ローシェルフの持ち上げと相殺
    assert r[2] == pytest.approx(0.6, abs=1.0)  # 1kHz はほぼ素通し
    assert r[3] == pytest.approx(3.0, abs=0.3)  # 3kHz のベル +3dB
    assert r[4] == pytest.approx(0.0, abs=0.5)


def test_eq_zero_gain_bands_are_skipped():
    assert len(eq_sos([{"type": "bell", "freq": 1000, "gain_db": 0.0}], FS)) == 0


def test_static_curve_hard_and_soft_knee():
    lv = np.array([-30.0, -10.0, 10.0])
    g = static_gain_db(lv, threshold_db=-10, ratio=4, knee_db=0)
    assert g.tolist() == pytest.approx([0.0, 0.0, -15.0])  # 20dB 超えて 4:1 → 5dB に（-15dB）
    soft = static_gain_db(np.array([-10.0]), threshold_db=-10, ratio=4, knee_db=10)
    assert -2.0 < soft[0] < 0  # ソフトニーはしきい値ちょうどでも少し下がる


def test_compressor_reduces_loud_part_only():
    t = np.arange(2 * FS) / FS
    x = np.sin(2 * np.pi * 200 * t) * np.where(t < 1, 0.05, 1.0)  # 前半 -26dB、後半 0dB
    y = make_compressor(
        {"threshold_db": -10, "ratio": 4, "attack_ms": 0.7, "release_ms": 93}, FS
    )(x[None, :].astype(np.float32))[0]
    assert np.max(np.abs(y[: FS - 100])) == pytest.approx(0.05, rel=0.02)  # しきい値以下はそのまま
    tail = np.max(np.abs(y[int(1.5 * FS) :]))
    assert 20 * np.log10(tail) == pytest.approx(-7.5, abs=0.5)  # 0dB → -10 + 10/4 = -7.5dB


def test_stereo_compressor_keeps_balance():
    x = np.stack([np.full(FS, 0.9), np.full(FS, 0.3)]).astype(np.float32)
    y = make_compressor({"threshold_db": -20, "ratio": 10}, FS)(x)
    assert y[0, -1] / y[1, -1] == pytest.approx(3.0, rel=1e-4)


def test_gain_after_compressor_order_matters():
    x = np.full((1, FS), 1.0, dtype=np.float32)  # 0dB
    comp = {"type": "compressor", "threshold_db": -10, "ratio": 4}
    after = make_chain([comp, {"type": "gain", "db": 3.2}], FS)(x)  # -7.5 + 3.2
    before = make_chain([{"type": "gain", "db": 3.2}, comp], FS)(x)  # -10 + 13.2/4
    assert 20 * np.log10(after[0, -1]) == pytest.approx(-4.3, abs=0.05)
    assert 20 * np.log10(before[0, -1]) == pytest.approx(-6.7, abs=0.05)


def test_chain_and_validate():
    chain = make_chain([{"type": "eq", "bands": []}, {"type": "compressor", "threshold_db": 0, "ratio": 2, "enabled": False}], FS)
    x = np.ones((1, 100), dtype=np.float32)
    assert np.array_equal(chain(x), x)
    assert validate([{"type": "reverb"}], "voices[0].effects")
    assert validate([{"type": "compressor", "ratio": 2}], "m")  # threshold_db がない
