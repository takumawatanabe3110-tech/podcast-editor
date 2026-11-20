import numpy as np
import pytest
from scipy.signal import sosfreqz

from podcast_engine.effects import eq_sos, make_chain, gate_gain_db, make_compressor, static_gain_db, validate

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


# ---------------------------------------------------------------- ゲート


def _burst_signal(fs=24000):
    rng = np.random.default_rng(1)
    x = (rng.standard_normal(int(2.5 * fs)) * 10 ** (-70 / 20) * 0.3).astype(np.float32)  # 小さいノイズ
    t = np.arange(int(0.3 * fs)) / fs
    tone = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    for start in (int(0.3 * fs), int(1.7 * fs)):
        x[start:start + len(tone)] = tone
    return x[None, :]


def _rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-12)


def test_gate_gain_db_curve():
    g = gate_gain_db(np.array([-80.0, -50.0, -10.0]), -50, 30)
    assert g.tolist() == [-30.0, 0.0, 0.0]


def test_gate_reduces_quiet_and_keeps_loud():
    fs = 24000
    x = _burst_signal(fs)
    y = make_chain([{"type": "gate", "threshold_db": -50, "range_db": 30, "attack_ms": 1, "hold_ms": 50, "release_ms": 150}], fs)(x)
    # 最初の無音部分（閉じたまま）と、バースト後に十分落ち着いた部分は range_db 下がる
    for a, b in ((0.0, 0.25), (1.3, 1.65)):
        sl = slice(int(a * fs), int(b * fs))
        assert _rms_db(y[0, sl]) - _rms_db(x[0, sl]) == pytest.approx(-30, abs=1.0)
    # 大きい部分（開ききった後）はそのまま
    sl = slice(int(0.35 * fs), int(0.55 * fs))
    assert _rms_db(y[0, sl]) - _rms_db(x[0, sl]) == pytest.approx(0, abs=0.5)


def test_gate_hold_keeps_open():
    fs = 24000
    x = _burst_signal(fs)
    base = {"type": "gate", "threshold_db": -50, "range_db": 30, "attack_ms": 1, "release_ms": 20}
    end = int(0.6 * fs)  # バーストの終わり
    sl = slice(end + int(0.01 * fs), end + int(0.04 * fs))  # 終わりの 10〜40ms 後
    held = make_chain([{**base, "hold_ms": 100}], fs)(x)
    nohold = make_chain([{**base, "hold_ms": 0}], fs)(x)
    assert _rms_db(held[0, sl]) - _rms_db(x[0, sl]) > -1.0  # ホールド中は開いたまま
    assert _rms_db(nohold[0, sl]) - _rms_db(x[0, sl]) < -10  # ホールド 0 なら閉じていく


def test_gate_disabled_is_noop():
    x = _burst_signal()
    y = make_chain([{"type": "gate", "threshold_db": -50, "enabled": False}], 24000)(x)
    assert np.array_equal(x, y)


def test_gate_validate():
    assert validate([{"type": "gate", "threshold_db": -50}], "fx") == []
    assert validate([{"type": "gate"}], "fx")
    assert validate([{"type": "gate", "threshold_db": -50, "range_db": -1}], "fx")


def _band_energy_db(x, lo, hi):
    spec = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / FS)
    return 10 * np.log10(spec[(f >= lo) & (f < hi)].sum() + 1e-20)


def test_compressor_gain_ramp_removes_block_rate_buzz():
    # 速いアタックで音量が階段になると 4kHz 付近に「ジリジリ」が出る。直線でつなげば出ない
    t = np.arange(2 * FS) / FS
    x = sum(np.sin(2 * np.pi * 200 * k * t) / k for k in range(1, 8)) * (0.6 + 0.4 * np.sin(2 * np.pi * 5 * t))
    x = (x / np.abs(x).max() * 0.9).astype(np.float32)[None, :]
    p = {"threshold_db": -10, "ratio": 4, "knee": 0, "attack_ms": 0.7, "release_ms": 93}
    y = make_compressor(p, FS)(x)[0]

    # 同じ音量の階段版を作る（検出と平滑化は本体と同じ式）
    block = int(FS * 0.00025)
    nb = len(t) // block
    peak = np.abs(x[0, : nb * block]).reshape(nb, block).max(axis=1)
    target = static_gain_db(20 * np.log10(np.maximum(peak, 1e-9)), -10, 4, 0.0)
    ca, cr = np.exp(-block / (0.0007 * FS)), np.exp(-block / (0.093 * FS))
    g, cur = np.empty(nb), 0.0
    for i, tg in enumerate(target):
        c = ca if tg < cur else cr
        cur = tg + c * (cur - tg)
        g[i] = cur
    step = x[0] * (10 ** (np.repeat(g, block) / 20)).astype(np.float32)

    ramp_buzz = _band_energy_db(y, 3500, 4500)
    step_buzz = _band_energy_db(step, 3500, 4500)
    print(f"3.5-4.5kHz: step {step_buzz:.1f} dB, ramp {ramp_buzz:.1f} dB")
    assert step_buzz - ramp_buzz >= 10
    # 声の帯域（0〜3kHz）は階段版と変わらない
    assert abs(_band_energy_db(y, 0, 3000) - _band_energy_db(step, 0, 3000)) < 0.1
