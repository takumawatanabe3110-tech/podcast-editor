import numpy as np
import pytest
import soundfile as sf

from podcast_engine import cli
from podcast_engine.project import BgmClip, Edit, Keyframe, Output, Project, Segment, Source, Sync, TrackOffset, Voice

RAW = Output(loudness_lufs=None)  # 音量そのものを確かめるテストではラウドネス調整をしない
from podcast_engine.render import bgm_envelope, render, render_voice, voice_keyframe_gain_db, write
from podcast_engine.synth import SynthTrack, make_session, write_session

FS = 48000


# ---------------------------------------------------------------- 編集（カット）の計算


def test_cut_splits_and_spans_segments():
    e = Edit(segments=[Segment(0, 100)], crossfade_ms=0)
    e.cut(10, 20)
    assert [(s.start, s.end) for s in e.segments] == [(0, 10), (20, 100)]
    e.cut(5, 30)  # 2つの区間にまたがる
    assert [(s.start, s.end) for s in e.segments] == [(0, 5), (30, 100)]
    e.cut(0, 5)  # 区間まるごと
    assert [(s.start, s.end) for s in e.segments] == [(30, 100)]
    with pytest.raises(ValueError):
        e.cut(50, 40)


def test_layout_and_time_mapping_with_crossfade():
    e = Edit(position=2.0, segments=[Segment(10, 20), Segment(50, 60)], crossfade_ms=10)
    lay = e.layout()
    assert lay[0][0] == pytest.approx(2.0)
    assert lay[1][0] == pytest.approx(2.0 + 10 - 0.01)
    assert e.output_end == pytest.approx(2.0 + 20 - 0.01)
    assert e.output_to_reference(3.0) == pytest.approx(11.0)
    assert e.reference_to_output(55.0) == pytest.approx(2.0 + 10 - 0.01 + 5)
    assert e.reference_to_output(30.0) is None  # カットされた部分


def test_project_roundtrip(tmp_path):
    p = Project(
        name="t", sources={"a": Source("a.wav"), "m": Source("m.mp3", "bgm")},
        sync=Sync("a", {"b": TrackOffset(-2.4, 0.1, "clap")}),
        voices=[Voice("a", "青木さん", 24.4)],
        edit=Edit(1.0, [Segment(0, 5)]),
        bgm=[BgmClip("m", 0.0, 10.0, keyframes=[Keyframe(1.0, -14.5)])],
    )
    p.save(tmp_path / "x.podproj")
    q = Project.load(tmp_path / "x.podproj")
    assert q == p
    assert "青木さん" in (tmp_path / "x.podproj").read_text(encoding="utf-8")


def test_validate_reports_missing_source():
    p = Project(voices=[Voice("nope")], edit=Edit(segments=[Segment(0, 1)]))
    assert any("nope" in m for m in p.validate())


# ---------------------------------------------------------------- 書き出し


def _session(tmp_path, starts, **kw):
    tracks = [SynthTrack(s) for s in starts]
    waves = make_session(tracks, fs=FS, **kw)
    paths = [tmp_path / f"v{i}.wav" for i in range(len(waves))]
    write_session([str(p) for p in paths], waves, FS)
    return paths


def _clap_time(x):
    """一番大きい立ち上がりの位置（サンプル）。"""
    return int(np.argmax(np.abs(np.diff(x))))


def test_render_aligns_tracks_using_sync(tmp_path):
    # 2本目は録音開始が 2.397 秒遅い → offset -2.397
    paths = _session(tmp_path, [1.0, 3.397], duration=20, clap_at=6.0, crosstalk=0.0, false_transient_at=None)
    p = Project(
        sample_rate=FS,
        sources={"a": Source(str(paths[0])), "b": Source(str(paths[1]))},
        sync=Sync("a", {"b": TrackOffset(-2.397)}),
        voices=[Voice("a"), Voice("b")],
        edit=Edit(position=0.0, segments=[Segment(3.0, 15.0)]),
    )
    n = int(12.0 * FS)
    ya = render_voice(p, p.voices[0], tmp_path, n)
    yb = render_voice(p, p.voices[1], tmp_path, n)
    # 拍手は本当の時刻 6.0 → 基準時刻 5.0 → 出力時刻 2.0
    assert abs(_clap_time(ya) - 2.0 * FS) < 0.01 * FS
    assert abs(_clap_time(ya) - _clap_time(yb)) <= 1


def test_render_cut_removes_audio_and_shortens(tmp_path):
    paths = _session(tmp_path, [0.0], duration=20, clap_at=8.0, false_transient_at=None)
    p = Project(
        sample_rate=FS, sources={"a": Source(str(paths[0]))}, sync=Sync("a"),
        voices=[Voice("a")], edit=Edit(segments=[Segment(0.0, 20.0)], crossfade_ms=10), output=RAW,
    )
    p.edit.cut(7.5, 9.0)  # 拍手（8.0秒）を含む区間を切る
    audio, rep = render(p, tmp_path)
    assert rep.duration == pytest.approx(20.0 - 1.5 - 0.01, abs=1e-3)
    # 拍手（素材で一番大きい音）がなくなっている。中央パンで -3dB されるので戻して比べる
    full = sf.read(paths[0])[0]
    left_as_source = audio[0] / np.cos(np.pi / 4)
    assert np.max(np.abs(left_as_source)) < 0.5 * np.max(np.abs(full))


def test_bgm_envelope_keyframes_and_fades():
    clip = BgmClip("m", at=0.0, duration=10.0, gain_db=-6.0, fade_in=1.0,
                   keyframes=[Keyframe(2.0, 0.0), Keyframe(4.0, -14.0)])
    env = bgm_envelope(clip, 10 * 100, 100)  # 100Hz で十分
    assert env[0] == pytest.approx(0.0)  # フェードイン開始
    assert env[150] == pytest.approx(10 ** (-6 / 20), rel=1e-3)  # 1.5秒：キーフレーム前は最初の値を保持
    assert env[300] == pytest.approx(10 ** (-13 / 20), rel=1e-3)  # 3秒：0→-14 の中間
    assert env[900] == pytest.approx(10 ** (-20 / 20), rel=1e-3)  # 最後のキーフレーム以降は保持


def test_bgm_fade_out_curve():
    fs = 100
    lin = bgm_envelope(BgmClip("m", 0.0, 10.0, fade_out=4.0), 1000, fs)
    sq = bgm_envelope(BgmClip("m", 0.0, 10.0, fade_out=4.0, fade_out_curve=2.0), 1000, fs)
    assert lin[599] == pytest.approx(1.0, abs=0.01) and sq[599] == pytest.approx(1.0, abs=0.01)  # 6秒までは素通し
    assert lin[800] == pytest.approx(0.5)  # 半分経過：直線は 0.5
    assert sq[800] == pytest.approx(0.75)  # 曲線 2 は 1−0.5² = 0.75（最初はゆっくり）
    assert sq[999] == pytest.approx(0.0, abs=0.01)
    fin = bgm_envelope(BgmClip("m", 0.0, 10.0, fade_in=4.0, fade_in_curve=2.0), 1000, fs)
    assert fin[200] == pytest.approx(0.75)  # フェードインは裏返し：半分で 0.75


def test_render_places_bgm_and_writes_mp3(tmp_path):
    t = np.arange(int(4.0 * 44100)) / 44100
    tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    sf.write(tmp_path / "bgm.wav", np.stack([tone, tone], 1), 44100, subtype="FLOAT")  # 44.1k → 48k
    p = Project(
        sample_rate=FS, sources={"m": Source("bgm.wav", "bgm")},
        bgm=[BgmClip("m", at=1.0, duration=2.0, offset_in=0.5)], output=RAW,
    )
    audio, rep = render(p, tmp_path)
    assert audio.shape == (2, 3 * FS)
    assert np.max(np.abs(audio[:, : FS - 10])) == 0  # 1秒目までは無音
    assert np.max(np.abs(audio[:, FS + 100 : 3 * FS - 100])) == pytest.approx(0.5, abs=0.01)

    write(tmp_path / "out.mp3", audio, rep.sample_rate, 128)
    from pedalboard.io import AudioFile

    with AudioFile(str(tmp_path / "out.mp3")) as f:
        assert f.samplerate == FS and f.num_channels == 2
        assert f.frames / FS == pytest.approx(3.0, abs=0.1)  # MP3 は前後に少し無音が付く


def test_cli_init_cut_render(tmp_path):
    paths = _session(tmp_path, [1.0, 2.0], duration=30, clap_at=5.0)
    proj = tmp_path / "ep.podproj"
    assert cli.main(["init", *map(str, paths), "--out", str(proj), "--names", "青木さん", "内田さん"]) == 0
    assert Project.load(proj).voices[0].denoise == {"method": "deepfilternet", "atten_lim_db": None}  # 初期値
    assert cli.main(["init", *map(str, paths), "--out", str(proj), "--names", "青木さん", "内田さん", "--no-denoise"]) == 0
    p = Project.load(proj)
    assert p.voices[0].denoise is None
    assert [v.name for v in p.voices] == ["青木さん", "内田さん"]
    assert p.sources["voice1"].path == "v0.wav"  # .podproj からの相対パス
    assert p.sync.tracks["voice2"].offset_sec == pytest.approx(-1.0, abs=0.001)
    # 2本目は1秒遅く始まる → 基準時刻 1.0 から。1本目は 30 秒で終わる
    assert p.edit.segments[0].start == pytest.approx(1.0, abs=0.001)
    assert p.edit.segments[0].end == pytest.approx(30.0, abs=0.001)

    assert cli.main(["cut", str(proj), "0:10", "0:12.5"]) == 0
    assert len(Project.load(proj).edit.segments) == 2
    assert cli.main(["render", str(proj), "--out", str(tmp_path / "ep.wav")]) == 0
    x, fs = sf.read(tmp_path / "ep.wav")
    assert x.shape[1] == 2
    assert len(x) / fs == pytest.approx(29.0 - 2.5 - 0.01, abs=1e-3)


def test_voice_keyframe_gain_helper():
    kf = [Keyframe(1.0, -60.0), Keyframe(2.0, 0.0)]
    g = voice_keyframe_gain_db(kf, [0.0, 1.0, 1.5, 2.0, 5.0])
    assert list(g) == pytest.approx([-60, -60, -30, 0, 0])
    assert list(voice_keyframe_gain_db([], [0.0, 3.0])) == [0, 0]


def test_voice_keyframes_roundtrip():
    p = Project(sources={"a": Source("a.wav")}, voices=[Voice("a", keyframes=[Keyframe(1.0, -6.0)])])
    q = Project.from_dict(p.to_dict())
    assert q.voices[0].keyframes == [Keyframe(1.0, -6.0)]
    d = p.to_dict()
    del d["voices"][0]["keyframes"]
    assert Project.from_dict(d).voices[0].keyframes == []


def test_voice_keyframes_apply_by_reference_time(tmp_path):
    sf.write(tmp_path / "a.wav", np.full(8 * FS, 0.5, dtype=np.float32), FS, subtype="FLOAT")
    p = Project(
        sample_rate=FS, sources={"a": Source("a.wav")}, sync=Sync("a"),
        voices=[Voice("a", keyframes=[Keyframe(1.0, -60.0), Keyframe(2.0, 0.0)])],
        edit=Edit(segments=[Segment(0.0, 8.0)], crossfade_ms=10), output=RAW,
    )
    p.edit.cut(3.0, 4.0)  # 4 秒以降は出力時刻が 1 秒前にずれる
    x = render_voice(p, p.voices[0], tmp_path, int(7 * FS))
    assert np.max(np.abs(x[: int(0.9 * FS)])) < 0.5 * 10 ** (-50 / 20)  # 参照 1 秒より前はほぼ無音
    assert x[int(2.5 * FS)] == pytest.approx(0.5, abs=1e-3)  # 参照 2 秒以降はそのまま
    # カットの後ろ：出力 3.5 秒 = 参照 4.5 秒 → 0dB のまま
    assert x[int(3.5 * FS)] == pytest.approx(0.5, abs=1e-3)
    # 参照 1.5 秒（出力 1.5 秒）は中間の -30dB
    assert x[int(1.5 * FS)] == pytest.approx(0.5 * 10 ** (-30 / 20), rel=0.02)


@pytest.mark.parametrize("ext", ["wav", "mp3"])
def test_export_progress_monotonic_to_one(tmp_path, ext):
    from podcast_engine.server import export

    sf.write(tmp_path / "a.wav", (np.random.default_rng(0).standard_normal(3 * FS) * 0.1).astype(np.float32), FS, subtype="FLOAT")
    p = Project(
        sample_rate=FS, sources={"a": Source("a.wav")}, sync=Sync("a"),
        voices=[Voice("a")],
        edit=Edit(segments=[Segment(0.0, 3.0)]),
        output=Output(sample_rate=FS, channels=2, loudness_lufs=-14.0, true_peak_dbtp=-1.0),
    )
    calls = []
    export(p, tmp_path, tmp_path / f"o.{ext}", lambda f, s: calls.append((f, s)))
    fr = [f for f, _ in calls]
    assert fr == sorted(fr) and fr[-1] == 1.0 and 0.0 <= fr[0] and len(fr) >= 4
    assert all(isinstance(s, str) and s for _, s in calls)


def test_offset_nudge_shifts_voice_in_render(tmp_path):
    """同期オフセットを数 ms 微調整すると、書き出しでその声がちょうどその分だけずれる。
    file時刻 = 基準時刻 + offset_sec なので、offset を d 減らすと声は d 秒「遅く」鳴る。"""
    click_file_t = 5.0
    ref = np.zeros(int(10 * FS), dtype=np.float32)
    ref[int(1.0 * FS)] = 0.2  # 基準側にも小さなクリック（影響しないことの確認）
    voice = np.zeros(int(10 * FS), dtype=np.float32)
    voice[int(click_file_t * FS)] = 0.8
    sf.write(tmp_path / "ref.wav", ref, FS, subtype="FLOAT")
    sf.write(tmp_path / "b.wav", voice, FS, subtype="FLOAT")

    def click_pos(offset):
        p = Project(
            sample_rate=FS,
            sources={"a": Source(str(tmp_path / "ref.wav")), "b": Source(str(tmp_path / "b.wav"))},
            sync=Sync("a", {"b": TrackOffset(offset)}),
            voices=[Voice("a"), Voice("b")],
            edit=Edit(position=0.0, segments=[Segment(2.0, 9.0)], crossfade_ms=0),
            output=RAW,
        )
        audio, _ = render(p, tmp_path)
        mono = np.abs(audio).sum(axis=0)
        mono[: int(2.0 * FS)] = 0  # 基準側クリック（出力 -1秒付近）は範囲外だが念のため
        return int(np.argmax(mono))

    base = click_pos(-1.0)  # 出力時刻 = 5.0 - (-1.0) - 2.0 = 4.0 秒
    assert abs(base - 4.0 * FS) <= 1
    assert abs((click_pos(-1.0 - 0.010) - base) - round(0.010 * FS)) <= 1  # 10ms 遅く
    assert abs((click_pos(-1.0 + 0.001) - base) - round(-0.001 * FS)) <= 1  # 1ms 早く
