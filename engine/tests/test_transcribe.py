from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from podcast_engine import cli, transcribe
from podcast_engine.project import BgmClip, Edit, Project, Segment, Source, Sync, TrackOffset, Voice
from podcast_engine.transcribe import (
    ENV_HOP_SEC, Transcript, Utterance, Word, apply_corrections, assign_speakers, build_utterances, mark_fillers,
)

FS = 48000


def _w(t0, t1, s):
    return Word(t0, t1, s)


def test_assign_speakers_drops_crosstalk_keeps_backchannel():
    n = int(10 / ENV_HOP_SEC)
    env_a = np.full(n, -60.0)
    env_b = np.full(n, -60.0)
    env_a[int(1 / ENV_HOP_SEC):int(4 / ENV_HOP_SEC)] = -20  # 1〜4秒は A が話す（B のマイクには -40 でかぶる）
    env_b[int(1 / ENV_HOP_SEC):int(4 / ENV_HOP_SEC)] = -40
    env_b[int(5 / ENV_HOP_SEC):int(6 / ENV_HOP_SEC)] = -22  # 5〜6秒は B の相づち
    env_a[int(5 / ENV_HOP_SEC):int(6 / ENV_HOP_SEC)] = -45
    words = {
        "a": [_w(1.0, 1.5, "今日"), _w(1.5, 2.0, "は")],
        "b": [_w(1.0, 1.5, "今日"), _w(5.1, 5.6, "なるほど")],  # 1秒の「今日」は A の声のかぶり
    }
    kept = assign_speakers(words, {"a": env_a, "b": env_b}, env_start=0.0)
    assert [w.w for w in kept["a"]] == ["今日", "は"]
    assert [w.w for w in kept["b"]] == ["なるほど"]


def test_long_phrase_keeps_words_outside_the_overlap():
    # A のトラックで、B の声のかぶり（1〜3秒）と A 自身の声（3〜6秒）が1つの長いフレーズになった場合
    n = int(10 / ENV_HOP_SEC)
    env_a = np.full(n, -60.0)
    env_b = np.full(n, -60.0)
    env_b[int(1 / ENV_HOP_SEC):int(3 / ENV_HOP_SEC)] = -15  # B が話す
    env_a[int(1 / ENV_HOP_SEC):int(3 / ENV_HOP_SEC)] = -30
    env_a[int(3 / ENV_HOP_SEC):int(6 / ENV_HOP_SEC)] = -12  # A が話す
    env_b[int(3 / ENV_HOP_SEC):int(6 / ENV_HOP_SEC)] = -30
    a = [_w(1.0 + 0.25 * i, 1.25 + 0.25 * i, c) for i, c in enumerate("かぶりかぶりかぶ")]  # 1〜3秒
    a += [_w(3.0 + 0.25 * i, 3.25 + 0.25 * i, c) for i, c in enumerate("本当にそうですね次回もよろしく"[:12])]
    b = [_w(1.0, 3.0, "ちゃんと")]
    kept = assign_speakers({"a": a, "b": b}, {"a": env_a, "b": env_b}, 0.0)
    assert [w.w for w in kept["b"]] == ["ちゃんと"]
    assert "".join(w.w for w in kept["a"]).startswith("本当に")  # 重ならない部分は残る
    assert all(w.t0 >= 3.0 for w in kept["a"])


def test_speech_end_ignores_low_confidence_chatter_after_a_gap():
    def u(t0, t1, p):
        return Utterance("x", "a", t0, t1, "あ", "あ", [Word(t0, t1, "あ", p)])
    tr = Transcript("m", "ja", [u(0, 10, 0.95), u(20, 21, 0.9), u(23.5, 27, 0.4)])
    assert tr.speech_end == 21  # 2.5秒あいた後の自信のない声は、収録後の雑談とみなす
    tr = Transcript("m", "ja", [u(0, 10, 0.95), u(20, 21, 0.9), u(23.5, 27, 0.9)])
    assert tr.speech_end == 27  # はっきりした声なら本編
    tr = Transcript("m", "ja", [u(0, 10, 0.95), u(10.5, 12, 0.4)])
    assert tr.speech_end == 12  # 間が短ければ本編


def test_fillers_are_marked_and_removed_from_script():
    ws = [_w(0, .1, "え"), _w(.1, .2, "ー"), _w(.2, .3, "と"), _w(.3, .4, "、"), _w(.4, .5, "今"), _w(.5, .6, "日"),
          _w(.6, .7, "は"), _w(.7, .8, "あの"), _w(.8, .9, "、"), _w(.9, 1.0, "雨")]
    mark_fillers(ws)
    assert [w.filler for w in ws] == [True, True, True, False, False, False, False, True, False, False]
    u = build_utterances({"a": ws}, {"a": "青木さん"})[0]
    assert u.text == "えーと、今日はあの、雨"
    assert u.script == "今日は、雨"


def test_corrections_span_words_and_keep_times():
    ws = [_w(0.0, 0.2, "村"), _w(0.2, 0.4, "井ス"), _w(0.4, 0.6, "ラジ"), _w(0.6, 0.8, "オで"), _w(0.8, 1.0, "す")]
    out = apply_corrections(ws, {"村井スラジオ": "オムライスラヂオ"})
    assert [w.w for w in out] == ["オムライスラヂオで", "す"]  # 単語の中の余り（「で」）は残す
    assert (out[0].t0, out[0].t1) == (0.0, 0.8)
    # 直した言葉の中に元の言葉が入っていても、無限に置き換えない
    out = apply_corrections([_w(0, 1, "ラヂオ"), _w(1, 2, "ラヂオ")], {"ラヂオ": "オムライスラヂオ"})
    assert [w.w for w in out] == ["オムライスラヂオ", "オムライスラヂオ"]
    assert apply_corrections(ws, {}) == ws


def test_longer_correction_with_context_wins():
    # 同じ聞き間違い「内田立郎」でも、前後の言葉で直す先を変える（長い言い換えが優先）
    fixes = {"施設図書館の内田立郎": "私設図書館ルチャ・リブロ", "施設図書館": "私設図書館", "内田立郎": "内田樹"}
    ws = [_w(i, i + 1, c) for i, c in enumerate("施設図書館の内田立郎やってます")]
    assert "".join(w.w for w in apply_corrections(ws, fixes)) == "私設図書館ルチャ・リブロやってます"
    ws = [_w(i, i + 1, c) for i, c in enumerate("内田立郎先生と施設図書館")]
    assert "".join(w.w for w in apply_corrections(ws, fixes)) == "内田樹先生と私設図書館"


def test_utterances_split_by_speaker_and_gap():
    words = {
        "a": [_w(0.0, 0.3, "は"), _w(0.3, 0.6, "い"), _w(2.0, 2.3, "ま")],  # 1.4秒あいたら別の発言
        "b": [_w(0.7, 1.0, "う"), _w(1.0, 1.2, "ん")],
    }
    us = build_utterances(words, {"a": "青木さん", "b": "内田さん"})
    assert [(u.speaker, u.text) for u in us] == [("青木さん", "はい"), ("内田さん", "うん"), ("青木さん", "ま")]


def test_transcript_roundtrip_and_script(tmp_path):
    tr = Transcript("m", "ja", [
        Utterance("青木さん", "a", 65.25, 67.0, "えー今日は", "今日は", [_w(65.25, 67.0, "えー今日は")]),
        Utterance("内田さん", "b", 68.0, 68.5, "えー", "", [_w(68.0, 68.5, "えー")]),
    ])
    tr.save(tmp_path / "t.json")
    assert Transcript.load(tmp_path / "t.json") == tr
    assert tr.script_text() == "[01:05.2] 青木さん：今日は\n"  # フィラーだけの発言は台本に出さない
    assert tr.speech_end == 67.0


def _project(tmp_path):
    rng = np.random.default_rng(0)
    n = 20 * FS
    a = np.zeros(n, np.float32)
    b = np.zeros(n, np.float32)
    a[2 * FS:6 * FS] = rng.standard_normal(4 * FS) * 0.1  # 基準時刻 2〜6秒は青木さん
    b[: 2 * FS] = 0
    b[3 * FS:7 * FS] = a[2 * FS:6 * FS] * 0.05  # 内田さんのマイクに1秒遅れでかぶる（offset +1.0）
    b[10 * FS:11 * FS] = rng.standard_normal(FS) * 0.1  # 基準時刻 9〜10秒は内田さん
    sf.write(tmp_path / "a.wav", a, FS, subtype="FLOAT")
    sf.write(tmp_path / "b.wav", b, FS, subtype="FLOAT")
    p = Project(
        sample_rate=FS, sources={"a": Source("a.wav"), "b": Source("b.wav"), "ed": Source("a.wav", "bgm")},
        sync=Sync("a", {"b": TrackOffset(1.0)}),
        voices=[Voice("a", "青木さん"), Voice("b", "内田さん")],
        edit=Edit(segments=[Segment(0.0, 18.0)], end_after_speech_sec=0.8),
        bgm=[BgmClip("ed", at=-3.0, duration=2.0, anchor="voice_end")],
        corrections={"そうですね": "そうですねえ"},
    )
    p.save(tmp_path / "ep.podproj")
    return p


def _fake_whisper(monkeypatch, calls):
    """ファイル内の時刻で単語を返す（b.wav は基準時刻＋1秒）。"""
    def fake(path, cache_dir, prompt=None):
        calls.append((Path(path).name, prompt))
        if Path(path).name == "a.wav":
            return [{"t0": 2.0, "t1": 2.5, "w": "えー", "p": .9}, {"t0": 2.5, "t1": 3.0, "w": "今日", "p": .9},
                    {"t0": 3.0, "t1": 3.5, "w": "は", "p": .9}]
        return [{"t0": 3.5, "t1": 4.0, "w": "今日", "p": .5},  # かぶり（基準時刻 2.5〜3.0）
                {"t0": 10.0, "t1": 10.6, "w": "そうですね", "p": .9}]
    monkeypatch.setattr(transcribe, "transcribe_source", fake)


def test_transcribe_project_maps_times_and_speakers(tmp_path, monkeypatch):
    p = _project(tmp_path)
    calls = []
    _fake_whisper(monkeypatch, calls)
    tr = transcribe.transcribe_project(p, tmp_path)
    assert [(u.speaker, u.script) for u in tr.utterances] == [("青木さん", "今日は"), ("内田さん", "そうですねえ")]
    assert tr.utterances[1].start == pytest.approx(9.0)  # ファイルの 10.0 秒 → 基準時刻 9.0 秒
    assert calls[0][1] is None  # プロンプトは使わない


def test_cli_transcribe_trims_end_and_ed_follows(tmp_path, monkeypatch):
    p = _project(tmp_path)
    _fake_whisper(monkeypatch, [])
    ed_before = p.bgm_start(p.bgm[0])
    assert cli.main(["transcribe", str(tmp_path / "ep.podproj")]) == 0
    q = Project.load(tmp_path / "ep.podproj")
    assert q.edit.segments[-1].end == pytest.approx(9.6 + 0.8)  # 最後の言葉の 0.8 秒後
    assert q.bgm_start(q.bgm[0]) == pytest.approx(10.4 - 3.0)  # ED が話の終わりについてくる
    assert ed_before == pytest.approx(18.0 - 3.0)
    assert (tmp_path / "ep.transcript.txt").read_text(encoding="utf-8").startswith("[00:02.5] 青木さん：今日は")
    assert Transcript.load(tmp_path / "ep.transcript.json").utterances[0].text == "えー今日は"


REAL = Path(__file__).resolve().parents[2] / "サンプルファイル/9-25_okadayama/2026_09_25_1.wav"


@pytest.mark.skipif(not REAL.exists(), reason="実際の収録素材（リポジトリ外）がないためスキップ")
def test_real_whisper_short(tmp_path):
    pytest.importorskip("mlx_whisper")
    x, _ = sf.read(str(REAL), start=300 * FS, stop=310 * FS, dtype="float32")  # 5:00〜5:10
    sf.write(tmp_path / "clip.wav", x, FS, subtype="FLOAT")
    words = transcribe.transcribe_source(tmp_path / "clip.wav", tmp_path / ".podcache")
    text = "".join(w["w"] for w in words)
    assert "図書館" in text
    assert all(0 <= w["t0"] <= w["t1"] <= 10.5 for w in words)
    assert list((tmp_path / ".podcache").glob("clip.whisper-*.json"))  # キャッシュされる
