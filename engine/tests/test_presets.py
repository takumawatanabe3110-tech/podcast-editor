import json

import numpy as np
import pytest
import soundfile as sf

from podcast_engine import cli
from podcast_engine.presets import PRESET_DIR, find_preset, load_preset, voice_loudness
from podcast_engine.project import Project
from podcast_engine.synth import SynthTrack, make_session, write_session

FS = 48000


def _preset(tmp_path):
    t = np.arange(20 * FS) / FS
    tone = (0.3 * np.sin(2 * np.pi * 330 * t)).astype(np.float32)
    (tmp_path / "bgm").mkdir()
    sf.write(tmp_path / "bgm/op.wav", np.stack([tone, tone], 1), FS, subtype="FLOAT")
    sf.write(tmp_path / "bgm/ed.wav", np.stack([tone, tone], 1), FS, subtype="FLOAT")
    d = {
        "format": "podpreset", "version": 1, "name": "test",
        "edit": {"start_after_clap_sec": 0.6, "position": 3.0, "crossfade_ms": 10},
        "denoise": {"method": "deepfilternet", "atten_lim_db": None},
        "voices": [
            {"name": "青木さん", "target_lufs": -13.6, "effects": [{"type": "gain", "db": 5.0}]},
            {"name": "内田さん", "target_lufs": -13.6, "effects": [{"type": "gain", "db": 5.0}]},
        ],
        "default_voice": {"name": "ゲスト", "gain_db": 20.0},
        "bgm": [
            {"source": "op", "path": "../bgm/op.wav", "anchor": "voice_start", "at": -3.0, "duration": 10.0,
             "keyframes": [{"anchor": "voice_start", "t": -0.5, "db": 0.0},
                           {"anchor": "voice_start", "t": 1.5, "db": -15.0},
                           {"anchor": "clip_end", "t": -0.5, "db": -3.0}]},
            {"source": "ed", "path": "../bgm/ed.wav", "anchor": "voice_end", "at": -6.0, "duration": 9.0,
             "gain_db": -5.4, "fade_in": 1.0, "fade_out": 4.0, "fade_out_curve": 2.0},
        ],
        "master_effects": [{"type": "gain", "db": 3.2}],
        "output": {"loudness_lufs": -14.0, "true_peak_dbtp": -1.0},
    }
    p = tmp_path / "presets/test.json"
    p.parent.mkdir()
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return p


def _voices(tmp_path, n=2):
    starts = [1.0, 2.0, 1.5][:n]
    waves = make_session([SynthTrack(s) for s in starts], fs=FS, duration=30, clap_at=5.0)
    waves = [w * g for w, g in zip(waves, [0.02, 0.05, 0.03])]  # 素材ごとに録音レベルが違う
    paths = [str(tmp_path / f"v{i}.wav") for i in range(n)]
    write_session(paths, waves, FS)
    return paths


def test_init_with_preset_fills_everything(tmp_path):
    preset = _preset(tmp_path)
    paths = _voices(tmp_path)
    proj = tmp_path / "ep/ep.podproj"
    proj.parent.mkdir()
    assert cli.main(["init", *paths, "--out", str(proj), "--preset", str(preset), "--no-denoise"]) == 0
    p = Project.load(proj)

    assert [v.name for v in p.voices] == ["青木さん", "内田さん"]
    assert all(v.denoise is None for v in p.voices)  # --no-denoise がプリセットより優先
    assert p.master_effects == [{"type": "gain", "db": 3.2}]
    # 声の大きさがそろう（録音レベルが違っても）
    for v in p.voices:
        assert voice_loudness(p, v.source, proj.parent) + v.gain_db == pytest.approx(-13.6, abs=0.02)
    assert p.voices[0].gain_db != pytest.approx(p.voices[1].gain_db, abs=1.0)
    # 拍手（本当の時刻 5.0 → 基準時刻 4.0）の 0.6 秒後から使う
    assert p.edit.segments[0].start == pytest.approx(4.6, abs=0.01)
    assert p.edit.position == 3.0

    op, ed = p.bgm
    assert (op.anchor, op.at) == ("voice_start", -3.0) and p.bgm_start(op) == pytest.approx(0.0)
    assert [k.t for k in op.keyframes] == pytest.approx([2.5, 4.5, 9.5])
    assert (ed.anchor, ed.at) == ("voice_end", -6.0)
    assert p.bgm_start(ed) == pytest.approx(p.edit.output_end - 6.0, abs=1e-3)
    # 話の終わりを切ると、ED もついてくる
    end_before = p.edit.output_end
    p.edit.cut(p.edit.segments[0].end - 2.0, p.edit.segments[0].end)
    assert p.bgm_start(ed) == pytest.approx(end_before - 2.0 - 6.0, abs=1e-3)
    assert ed.fade_out_curve == 2.0 and ed.gain_db == -5.4
    assert p.sources["op"].path == "../bgm/op.wav"  # プロジェクトからの相対パス
    assert p.validate() == []

    assert cli.main(["render", str(proj), "--out", str(tmp_path / "ep/ep.wav")]) == 0


def test_extra_voice_uses_default(tmp_path):
    preset = _preset(tmp_path)
    paths = _voices(tmp_path, n=3)
    proj = tmp_path / "ep.podproj"
    cli.main(["init", *paths, "--out", str(proj), "--preset", str(preset), "--no-denoise"])
    p = Project.load(proj)
    assert p.voices[2].name == "ゲスト" and p.voices[2].gain_db == 20.0


def test_names_option_wins_over_preset(tmp_path):
    preset = _preset(tmp_path)
    paths = _voices(tmp_path)
    proj = tmp_path / "ep.podproj"
    cli.main(["init", *paths, "--out", str(proj), "--preset", str(preset), "--no-denoise", "--names", "A", "B"])
    assert [v.name for v in Project.load(proj).voices] == ["A", "B"]


def test_missing_bgm_file_is_reported(tmp_path):
    preset = _preset(tmp_path)
    (tmp_path / "bgm/ed.wav").unlink()
    paths = _voices(tmp_path)
    with pytest.raises(FileNotFoundError, match="ed"):
        cli.main(["init", *paths, "--out", str(tmp_path / "ep.podproj"), "--preset", str(preset), "--no-denoise"])


def test_unknown_preset_lists_available():
    with pytest.raises(FileNotFoundError, match="okadayama"):
        find_preset("nope")


def test_okadayama_preset_is_well_formed():
    d, base = load_preset("okadayama")
    assert base == PRESET_DIR
    assert [v["name"] for v in d["voices"]] == ["青木さん", "内田さん"]
    assert {b["source"] for b in d["bgm"]} == {"op", "ed"}
    assert d["output"]["loudness_lufs"] == -14.0
