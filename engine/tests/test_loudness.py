import numpy as np
import pyloudnorm
import pytest
import soundfile as sf

from podcast_engine import cli
from podcast_engine.loudness import integrated_loudness, limit, normalize, true_peak_dbtp
from podcast_engine.render import write
from podcast_engine.synth import SynthTrack, make_session, write_session

FS = 48000


def _program(seconds=20, fs=FS, seed=0):
    """声っぽい合成音（ステレオ、間あり）。"""
    w = make_session([SynthTrack(0.0), SynthTrack(0.0)], fs=fs, duration=seconds, clap_at=3.0, seed=seed)
    return np.stack(w).astype(np.float32)


@pytest.mark.parametrize("fs", [48000, 44100])
def test_loudness_matches_pyloudnorm(fs):
    x = _program(fs=fs)
    ref = pyloudnorm.Meter(fs).integrated_loudness(x.T.astype(np.float64))
    assert integrated_loudness(x, fs) == pytest.approx(ref, abs=0.05)


def test_loudness_of_known_sine():
    # EBU の基準：1kHz・-18dBFS（ピーク）のステレオ正弦波は約 -18 LUFS
    # （K特性で1kHzは約+0.7dB、-0.691 の補正と相殺してほぼそのまま）
    t = np.arange(10 * FS) / FS
    s = (10 ** (-18 / 20) * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    x = np.stack([s, s])
    assert integrated_loudness(x, FS) == pytest.approx(-18.0, abs=0.1)


def test_true_peak_finds_intersample_peak():
    # fs/4 の正弦波を位相45度でサンプルすると、サンプル値は最大値の 0.707 にしかならない
    n = np.arange(FS)
    x = np.sin(2 * np.pi * n / 4 + np.pi / 4).astype(np.float32)[None, :]
    assert 20 * np.log10(np.abs(x).max()) == pytest.approx(-3.0, abs=0.05)
    assert true_peak_dbtp(x, FS) == pytest.approx(0.0, abs=0.2)


def test_limiter_keeps_ceiling_and_leaves_quiet_parts():
    x = _program() * 4  # ピークが大きく 0dB を超える
    y = limit(x, FS, ceiling_db=-1.0)
    assert true_peak_dbtp(y, FS) <= -1.0 + 0.05
    quiet = np.abs(x).max(axis=0) < 0.05  # 静かな部分（ピークから十分離れた場所）はほぼそのまま
    far = np.convolve(quiet, np.ones(int(0.2 * FS)), mode="same") >= int(0.2 * FS) - 1
    assert np.allclose(y[:, far], x[:, far], atol=1e-4)


def test_normalize_hits_target():
    x = _program() * 0.1
    y, before, after, tp = normalize(x, FS, -16.0, -1.0)
    assert before < -25
    assert after == pytest.approx(-16.0, abs=0.1)
    assert tp <= -1.0 + 0.05
    assert integrated_loudness(y, FS) == pytest.approx(after, abs=1e-6)


def test_render_applies_loudness_by_default(tmp_path, capsys):
    waves = make_session([SynthTrack(1.0), SynthTrack(2.0)], fs=FS, duration=30, clap_at=5.0)
    paths = [str(tmp_path / f"v{i}.wav") for i in range(2)]
    write_session(paths, waves, FS)
    proj = tmp_path / "ep.podproj"
    cli.main(["init", *paths, "--out", str(proj), "--no-denoise"])
    assert cli.main(["render", str(proj), "--out", str(tmp_path / "ep.wav")]) == 0
    x, fs = sf.read(tmp_path / "ep.wav", dtype="float32")
    assert integrated_loudness(x.T, fs) == pytest.approx(-14.0, abs=0.1)  # 初期値は -14 LUFS
    assert true_peak_dbtp(x.T, fs) <= -0.95
    assert "LUFS" in capsys.readouterr().err


def test_mp3_is_corrected_after_encoding(tmp_path):
    from pedalboard.io import AudioFile

    x = _program(seconds=30)
    y, _, _, _ = normalize(x, FS, -14.0, -1.0)
    plain = tmp_path / "plain.mp3"
    write(plain, y, FS, 128)  # 補正なし：MP3 化でラウドネスやピークがずれる
    with AudioFile(str(plain)) as f:
        d = f.read(f.frames)
    assert abs(integrated_loudness(d, FS) + 14.0) > 0.1 or true_peak_dbtp(d, FS) > -0.95
    lufs, tp = write(tmp_path / "fixed.mp3", y, FS, 128, -14.0, -1.0)
    with AudioFile(str(tmp_path / "fixed.mp3")) as f:
        z = f.read(f.frames)
    assert integrated_loudness(z, FS) == pytest.approx(lufs)
    assert lufs == pytest.approx(-14.0, abs=0.1)
    assert tp <= -1.0 + 0.1
