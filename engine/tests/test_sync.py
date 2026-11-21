import json

import numpy as np
import pytest

from podcast_engine import cli
from podcast_engine.sync import detect_transients, gcc_phat, sync_tracks
from podcast_engine.synth import SynthTrack, expected_offset, make_session, write_session

FS = 48000


def _write(tmp_path, tracks, **kw):
    waves = make_session(tracks, fs=FS, **kw)
    paths = [str(tmp_path / f"t{i}.wav") for i in range(len(waves))]
    write_session(paths, waves, FS)
    return paths


def test_gcc_phat_fractional_delay():
    rng = np.random.default_rng(1)
    x = rng.standard_normal(FS)
    f = np.fft.rfftfreq(2 * FS, 1 / FS)
    d = 123.4 / FS
    y = np.fft.irfft(np.fft.rfft(x, 2 * FS) * np.exp(-2j * np.pi * f * d), 2 * FS)[:FS]
    lag, _, ratio = gcc_phat(y, x, max_shift=500, interp=16)
    assert lag == pytest.approx(123.4, abs=0.05)
    assert ratio > 5


def test_detects_clap_and_knock():
    waves = make_session([SynthTrack(0.0)], fs=FS, duration=15, clap_at=8.0, false_transient_at=5.0)
    times = [t.time for t in detect_transients(waves[0], FS)]
    assert any(abs(t - 8.0) < 0.01 for t in times)
    assert any(abs(t - 5.0) < 0.01 for t in times)


def test_sync_negative_offset_with_false_transient(tmp_path):
    # 9/25 回と同じ向き・大きさのずれ（2本目は録音開始が 2.397 秒遅い＝同じ音が 2.397 秒早く鳴る）
    ref, oth = SynthTrack(1.0), SynthTrack(3.397)
    paths = _write(tmp_path, [ref, oth], duration=40, clap_at=12.0, false_transient_at=9.0)
    r = sync_tracks(paths, window_sec=20, max_offset_sec=10, drift_window_sec=10)
    t = r.tracks[1]
    assert expected_offset(ref, oth) == pytest.approx(-2.397)
    assert t.method == "clap"
    assert t.offset_sec == pytest.approx(expected_offset(ref, oth), abs=0.0002)
    assert r.clap_time_ref_sec == pytest.approx(12.0 - 1.0, abs=0.01)
    assert abs(t.drift_ppm) < 2


def test_sync_three_tracks_positive_offsets(tmp_path):
    tracks = [SynthTrack(3.0), SynthTrack(1.25), SynthTrack(0.4321)]
    paths = _write(tmp_path, tracks, duration=40, clap_at=6.0, false_transient_at=4.0)
    r = sync_tracks(paths, window_sec=20, max_offset_sec=10, drift_window_sec=10)
    assert r.tracks[0].is_reference
    for k in (1, 2):
        assert r.tracks[k].offset_sec == pytest.approx(expected_offset(tracks[0], tracks[k]), abs=0.0002)


def test_short_material_reports_no_drift(tmp_path):
    paths = _write(tmp_path, [SynthTrack(1.0), SynthTrack(2.0)], duration=40, clap_at=5.0)
    t = sync_tracks(paths, window_sec=15, max_offset_sec=5)
    assert t.tracks[1].drift_ppm == 0.0


def test_sync_measures_drift(tmp_path):
    # 時計が 40ppm 速いレコーダー。かぶり（3ms）があっても傾きを取り違えないこと
    fs = 16000
    ref, oth = SynthTrack(2.0), SynthTrack(1.0, drift_ppm=40.0)
    waves = make_session([ref, oth], fs=fs, duration=420, clap_at=4.0, false_transient_at=None)
    paths = [str(tmp_path / f"t{i}.wav") for i in range(2)]
    write_session(paths, waves, fs)
    r = sync_tracks(paths, window_sec=15, max_offset_sec=5)
    t = r.tracks[1]
    assert t.drift_points >= 5
    assert t.drift_ppm == pytest.approx(40.0, abs=5.0)
    assert t.offset_sec == pytest.approx(expected_offset(ref, oth), abs=0.0005)


def test_cli_writes_json(tmp_path, capsys):
    paths = _write(tmp_path, [SynthTrack(1.0), SynthTrack(2.0)], duration=30, clap_at=5.0)
    out = tmp_path / "sync.json"
    assert cli.main(["sync", *paths, "--window", "15", "--max-offset", "5", "--out", str(out)]) == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["tracks"][1]["offset_sec"] == pytest.approx(-1.0, abs=0.0005)
    assert "ずれ" in capsys.readouterr().err


def _rustle_session(tmp_path, fs=16000, duration=300.0):
    """真のずれ 17.5 秒。冒頭 25 秒に、両方のトラックに入る大きな物音（マイク調整のがさがさ）を、
    間違ったずれ（5.5 秒）で一致するように入れる。"""
    ref, oth = SynthTrack(20.0), SynthTrack(2.5)
    waves = make_session([ref, oth], fs=fs, duration=duration, clap_at=200.0, false_transient_at=None, seed=3)
    rng = np.random.default_rng(11)
    n = int(25 * fs)
    rustle = rng.standard_normal(n) * 1.0
    waves[0][:n] += rustle.astype(np.float32)
    s = int(5.5 * fs)  # 基準の時刻 t の物音が、もう一方では t + 5.5 秒に入る
    waves[1][s : s + n] += rustle.astype(np.float32)
    paths = [str(tmp_path / f"t{i}.wav") for i in range(2)]
    write_session(paths, waves, fs)
    return paths, expected_offset(ref, oth)


def test_global_check_fixes_wrong_head_estimate(tmp_path):
    paths, truth = _rustle_session(tmp_path)
    assert truth == pytest.approx(17.5)
    r = sync_tracks(paths, window_sec=60, max_offset_sec=30)
    t = r.tracks[1]
    assert t.offset_sec == pytest.approx(truth, abs=0.005)
    assert abs(t.drift_ppm) < 50
    assert t.method in ("global", "clap")
    assert t.warnings and "食い違う" in t.warnings[0]


def test_head_only_would_be_wrong(tmp_path):
    # 全体の測定を使わない（冒頭の窓だけ）と、物音に引っ張られて 5.5 秒付近になる＝テストが意味を持つ確認
    paths, _ = _rustle_session(tmp_path)
    from podcast_engine import sync as S

    orig = S._global_offsets
    S._global_offsets = lambda *a, **k: []
    try:
        t = sync_tracks(paths, window_sec=60, max_offset_sec=30, measure_drift=False).tracks[1]
    finally:
        S._global_offsets = orig
    assert abs(t.offset_sec - 17.5) > 1.0
    assert not t.warnings


def test_absurd_drift_is_rejected(tmp_path, monkeypatch):
    from podcast_engine import sync as S

    paths = _write(tmp_path, [SynthTrack(1.0), SynthTrack(2.0)], duration=30, clap_at=5.0)
    monkeypatch.setattr(S, "_measure_drift", lambda *a, **k: (22164.0, 14))
    t = sync_tracks(paths, window_sec=15, max_offset_sec=5).tracks[1]
    assert t.drift_ppm == 0.0 and t.drift_points == 0
    assert t.offset_sec == pytest.approx(-1.0, abs=0.0005)
    assert any("ドリフト" in w for w in t.warnings)
