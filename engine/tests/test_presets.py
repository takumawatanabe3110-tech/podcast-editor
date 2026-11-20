import json

import numpy as np
import pytest
import soundfile as sf

from podcast_engine import cli
from podcast_engine.presets import PRESET_DIR, find_preset, load_preset, voice_loudness
from podcast_engine.project import Keyframe, Project
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


# ---- 一覧・保存・逆変換

def _bare_project(tmp_path):
    from podcast_engine.project import Edit, Segment, Source, Sync, Voice

    (tmp_path / "ep").mkdir(exist_ok=True)
    sf.write(tmp_path / "ep/a.wav", 0.1 * np.sin(np.arange(30 * FS) / 20).astype(np.float32), FS, subtype="FLOAT")
    return Project(
        sources={"a": Source("a.wav")}, sync=Sync("a"), voices=[Voice("a")],
        edit=Edit(segments=[Segment(0.0, 30.0)]),
    )


def test_list_and_save_preset(tmp_path):
    from podcast_engine.presets import list_presets, save_preset

    (tmp_path / "b.json").write_text('{"format": "podpreset", "description": "B"}', encoding="utf-8")
    (tmp_path / "a.json").write_text('{"format": "podpreset"}', encoding="utf-8")
    (tmp_path / "x.json").write_text('{"format": "other"}', encoding="utf-8")
    assert list_presets(tmp_path) == [{"name": "a", "description": ""}, {"name": "b", "description": "B"}]
    save_preset(tmp_path / "c.json", {"z": 1, "a": "日本語"})
    txt = (tmp_path / "c.json").read_text(encoding="utf-8")
    assert txt.endswith("\n") and "日本語" in txt and txt.index('"z"') < txt.index('"a"')
    assert not list(tmp_path.glob("*.tmp"))


def test_clip_to_preset_round_trip(tmp_path):
    from podcast_engine.presets import apply_preset, clip_to_preset

    pf = _preset(tmp_path)
    preset, pdir = load_preset(str(pf))
    p = _bare_project(tmp_path)
    apply_preset(p, preset, pdir, tmp_path / "ep")
    for clip, orig in zip(p.bgm, preset["bgm"]):
        assert clip_to_preset(p, clip, pdir, tmp_path / "ep", orig) == orig
    # 声の位置が変わっても（別のエピソード）、基準についてくる
    p.edit.position = 7.0
    for clip, orig in zip(p.bgm, preset["bgm"]):
        assert clip_to_preset(p, clip, pdir, tmp_path / "ep", orig) == orig


def test_clip_to_preset_heuristic_without_existing(tmp_path):
    from podcast_engine.presets import apply_preset, clip_to_preset

    pf = _preset(tmp_path)
    preset, pdir = load_preset(str(pf))
    p = _bare_project(tmp_path)
    apply_preset(p, preset, pdir, tmp_path / "ep")
    e = clip_to_preset(p, p.bgm[0], pdir, tmp_path / "ep")
    assert e["path"] == "../bgm/op.wav" and e["anchor"] == "voice_start" and "gain_db" not in e
    kf = preset["bgm"][0]["keyframes"]
    # 声の始まりから 10 秒以内は voice_start が優先（短いクリップなので終わりのキーフレームもそうなる）
    assert e["keyframes"][:2] == kf[:2]
    assert e["keyframes"][2] == {"anchor": "voice_start", "t": 6.5, "db": -3.0}
    p.bgm[1].keyframes = [Keyframe(0.5, -3.0)]
    e = clip_to_preset(p, p.bgm[1], pdir, tmp_path / "ep")
    assert e["keyframes"] == [{"anchor": "voice_end", "t": -5.5, "db": -3.0}]
    # 声から遠く、終わりに近い → clip_end
    p.bgm[1].duration = 40.0
    p.bgm[1].at = -60.0
    p.bgm[1].keyframes = [Keyframe(35.0, -3.0)]
    e = clip_to_preset(p, p.bgm[1], pdir, tmp_path / "ep")
    assert e["keyframes"] == [{"anchor": "clip_end", "t": -5.0, "db": -3.0}]
    # どちらでもない → clip_start（anchor は省く）
    p.bgm[1].keyframes = [Keyframe(5.0, -3.0)]
    e = clip_to_preset(p, p.bgm[1], pdir, tmp_path / "ep")
    assert e["keyframes"] == [{"t": 5.0, "db": -3.0}]
    return
    p.bgm[1].duration = 40.0
    p.bgm[1].at = -60.0
    e = clip_to_preset(p, p.bgm[1], pdir, tmp_path / "ep")
    assert e["keyframes"] == [{"t": 0.5, "db": -3.0}]


def test_effects_for_track():
    from podcast_engine.presets import effects_for_track, set_effects_for_track

    pr = {"voices": [{"effects": [1]}], "default_voice": {"effects": [2]}, "bgm_effects": [3]}
    assert effects_for_track(pr, "voice:0") == [1]
    assert effects_for_track(pr, "voice:5") == [2]
    assert effects_for_track(pr, "bgm") == [3] and effects_for_track(pr, "master") == []
    set_effects_for_track(pr, "voice:0", [9])
    set_effects_for_track(pr, "voice:4", [8])
    set_effects_for_track(pr, "master", [7])
    assert pr["voices"][0]["effects"] == [9] and pr["default_voice"]["effects"] == [8] and pr["master_effects"] == [7]
    with pytest.raises(ValueError):
        set_effects_for_track(pr, "foo", [])


def test_init_stores_preset_name(tmp_path):
    p = Project.from_dict({"format": "podproj", "version": 1})
    assert p.preset == ""
    p.preset = "okadayama"
    assert Project.from_dict(p.to_dict()).preset == "okadayama"
