import io
import math
import threading
import time

import numpy as np
import pytest
import soundfile as sf

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from podcast_engine.project import BgmClip, Edit, Project, Segment, Source, Sync, TrackOffset, Voice  # noqa: E402
from podcast_engine.server import PEAK_RATE, PREVIEW_FS, create_app  # noqa: E402
from podcast_engine.transcribe import Transcript, Utterance, Word  # noqa: E402

FS = 48000


@pytest.fixture
def client(tmp_path):
    rng = np.random.default_rng(0)
    for name in ("a", "b"):
        sf.write(tmp_path / f"{name}.wav", (rng.standard_normal(4 * FS) * 0.1).astype(np.float32), FS, subtype="FLOAT")
    t = np.arange(3 * 44100) / 44100
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    sf.write(tmp_path / "bgm.wav", np.stack([tone, tone], 1), 44100, subtype="FLOAT")
    p = Project(
        sample_rate=FS,
        sources={"a": Source("a.wav"), "b": Source("b.wav"), "m": Source("bgm.wav", "bgm")},
        sync=Sync("a", {"b": TrackOffset(-0.5)}),
        voices=[Voice("a", "青木さん", 20.0), Voice("b", "内田さん", 21.0)],
        edit=Edit(position=1.0, segments=[Segment(0.5, 3.5)]),
        bgm=[BgmClip("m", at=-1.0, duration=2.0, anchor="voice_end")],
    )
    p.save(tmp_path / "ep.podproj")
    return TestClient(create_app(tmp_path / "ep.podproj")), tmp_path


def test_get_project_has_derived_values(client):
    c, _ = client
    d = c.get("/api/project").json()
    assert d["name"] == "ep.podproj"
    assert d["project"]["voices"][0]["name"] == "青木さん"
    assert d["derived"]["output_end"] == pytest.approx(4.0)
    assert d["derived"]["layout"] == [{"out_start": 1.0, "start": 0.5, "end": 3.5}]
    assert d["derived"]["bgm"][0]["start"] == pytest.approx(3.0)  # 声の終わり 4.0 − 1.0
    assert d["derived"]["sources"]["m"]["sample_rate"] == 44100


def test_put_project_saves_and_validates(client):
    c, tmp = client
    d = c.get("/api/project").json()["project"]
    d["edit"]["segments"] = [{"start": 0.5, "end": 1.5}, {"start": 2.0, "end": 3.5}]  # 1.5〜2.0 秒をカット
    r = c.put("/api/project", json=d)
    assert r.status_code == 200
    assert len(Project.load(tmp / "ep.podproj").edit.segments) == 2
    d["voices"][0]["source"] = "nope"
    r = c.put("/api/project", json=d)
    assert r.status_code == 400 and "nope" in r.json()["detail"]


def test_transcript_get_and_put(client):
    c, tmp = client
    assert c.get("/api/transcript").status_code == 404
    tr = Transcript("m", "ja", [Utterance("青木さん", "a", 1.0, 2.0, "えー今日は", "今日は",
                                         [Word(1.0, 1.4, "えー", filler=True), Word(1.4, 2.0, "今日は")])])
    tr.save(tmp / "ep.transcript.json")
    assert c.get("/api/transcript").json()["utterances"][0]["script"] == "今日は"
    d = tr.to_dict()
    d["utterances"][0]["script"] = "今日も"  # 文字の修正
    assert c.put("/api/transcript", json=d).status_code == 200
    assert (tmp / "ep.transcript.txt").read_text(encoding="utf-8") == "[00:01.4] 青木さん：今日も\n"


def test_peaks_and_preview_audio(client):
    c, tmp = client
    pk = c.get("/api/peaks/a").json()
    assert pk["rate"] == pytest.approx(PEAK_RATE)
    assert len(pk["min"]) == len(pk["max"]) == 4 * PEAK_RATE
    assert max(pk["max"]) == 127 or min(pk["min"]) == -127  # 一番大きいところで ±127
    r = c.get("/api/audio/m")
    x, fs = sf.read(io.BytesIO(r.content))
    assert fs == PREVIEW_FS and x.shape[1] == 2  # BGM はステレオのまま
    assert len(x) / fs == pytest.approx(3.0, abs=0.01)
    assert list((tmp / ".podcache").glob("bgm.preview-*.wav"))  # キャッシュされる
    assert c.get("/api/audio/nope").status_code == 404


def test_raw_audio_and_peaks(client):
    c, tmp = client
    r = c.get("/api/audio/a", params={"raw": 1})
    x, fs = sf.read(io.BytesIO(r.content))
    assert r.status_code == 200 and fs == PREVIEW_FS
    assert len(x) / fs == pytest.approx(4.0, abs=0.01)
    assert c.get("/api/audio/a").status_code == 200
    pk = c.get("/api/peaks/a", params={"raw": 1}).json()
    assert len(pk["min"]) == 4 * PEAK_RATE


def _wait_export(c, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        st = c.get("/api/export").json()
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.2)
    raise AssertionError("書き出しが終わりません")


def test_export_idle_at_first(client):
    c, _ = client
    assert c.get("/api/export").json() == {"state": "idle"}


@pytest.mark.parametrize("ext", ["wav", "mp3"])
def test_export_file(client, ext):
    c, tmp = client
    r = c.post("/api/export", json={"path": f"out.{ext}"})  # 相対パスは .podproj のフォルダから
    assert r.status_code == 200
    assert r.json() == {"state": "running", "path": str(tmp.resolve() / f"out.{ext}")}
    st = _wait_export(c)
    assert st["state"] == "done", st
    assert (tmp / f"out.{ext}").stat().st_size > 0
    rep = st["report"]
    assert set(rep) == {"duration", "sample_rate", "peak_dbfs", "clipped",
                        "loudness_before_lufs", "loudness_lufs", "true_peak_dbtp"}
    assert rep["duration"] > 3.0  # 頭の余白1秒 + 声3秒（+ BGM）
    assert math.isfinite(rep["loudness_lufs"])
    assert abs(rep["loudness_lufs"] - (-14.0)) < 0.5
    assert st["elapsed"] >= 0


def test_export_default_path_is_mp3_next_to_project(client):
    c, tmp = client
    assert c.post("/api/export").json()["path"] == str(tmp.resolve() / "ep.mp3")
    assert _wait_export(c)["state"] == "done"
    assert (tmp / "ep.mp3").exists()


def test_export_bad_extension(client):
    c, _ = client
    assert c.post("/api/export", json={"path": "out.flac"}).status_code == 400
    assert c.get("/api/export").json() == {"state": "idle"}


def test_export_conflict_while_running(client, monkeypatch):
    import podcast_engine.server as server

    c, tmp = client
    gate = threading.Event()
    from podcast_engine.render import RenderReport

    def slow_export(p, base, out):
        gate.wait(30)  # 合図が来るまで書き出し中のまま
        return RenderReport(1.0, 48000, -6.0, False)

    monkeypatch.setattr(server, "export", slow_export)
    assert c.post("/api/export", json={"path": "a.wav"}).status_code == 200
    st = c.get("/api/export").json()
    assert st["state"] == "running" and "started" in st and "elapsed" in st
    r = c.post("/api/export", json={"path": "b.wav"})
    assert r.status_code == 409 and "書き出し中" in r.json()["detail"]
    gate.set()
    assert _wait_export(c)["state"] in ("done", "error")


def test_export_error_is_reported(client):
    c, tmp = client
    (tmp / "a.wav").unlink()  # 素材がない
    assert c.post("/api/export", json={"path": "x.wav"}).status_code == 200
    st = _wait_export(c)
    assert st["state"] == "error" and "書き出しに失敗" in st["message"]


def test_page_is_not_cached(client):
    c, _ = client
    assert c.get("/api/project").headers["cache-control"] == "no-cache"


# ---- プリセット

@pytest.fixture
def pclient(client, monkeypatch):
    import json

    from podcast_engine import presets

    c, tmp = client
    pdir = tmp / "presets"
    pdir.mkdir()
    d = {
        "format": "podpreset", "version": 1, "name": "t", "description": "テスト",
        "voices": [{"name": "青木さん", "effects": []}], "default_voice": {"name": "ゲスト"},
        "bgm": [{"source": "m", "path": "../bgm.wav", "anchor": "voice_end", "at": -1.0, "duration": 2.0,
                 "keyframes": [{"anchor": "voice_end", "t": -0.5, "db": -3.0}]}],
    }
    (pdir / "t.json").write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(presets, "PRESET_DIR", pdir)
    return c, tmp, pdir


def test_presets_list_get_and_errors(pclient):
    c, _, _ = pclient
    assert c.get("/api/presets").json() == [{"name": "t", "description": "テスト"}]
    assert c.get("/api/presets/t").json()["name"] == "t"
    assert c.get("/api/presets/nai").status_code == 404
    assert c.get("/api/presets/..x").status_code == 400
    assert c.put("/api/presets/nai/bgm/m").status_code == 404
    assert c.put("/api/presets/t/bgm/zzz").status_code == 404


def test_save_bgm_to_preset_keeps_anchors_and_sets_project_preset(pclient):
    import json

    c, tmp, pdir = pclient
    proj = c.get("/api/project").json()["project"]
    assert proj["preset"] == ""
    proj["bgm"][0]["gain_db"] = -4.0
    proj["bgm"][0]["keyframes"] = [{"t": 0.5, "db": -3.0}]  # voice_end の 0.5 秒前 → 基準についていく形
    assert c.put("/api/project", json=proj).status_code == 200
    r = c.put("/api/presets/t/bgm/m")
    assert r.status_code == 200 and r.json()["preset"] == "t"
    e = r.json()["entry"]
    assert e["gain_db"] == -4.0 and e["path"] == "../bgm.wav" and e["anchor"] == "voice_end"
    assert e["keyframes"] == [{"anchor": "voice_end", "t": -0.5, "db": -3.0}]
    saved = json.loads((pdir / "t.json").read_text(encoding="utf-8"))
    assert saved["bgm"] == [e] and list(saved)[0] == "format"
    assert c.get("/api/project").json()["project"]["preset"] == "t"


def test_save_effects_to_preset(pclient):
    c, _, _ = pclient
    gain = [{"type": "gain", "db": 2.0}]
    for track in ("voice:0", "voice:3", "bgm", "master"):
        r = c.put(f"/api/presets/t/effects/{track}", json={"effects": gain})
        assert r.status_code == 200 and r.json() == {"preset": "t", "track": track, "effects": gain}
    pr = c.get("/api/presets/t").json()
    assert pr["voices"][0]["effects"] == gain and pr["default_voice"]["effects"] == gain
    assert pr["bgm_effects"] == gain and pr["master_effects"] == gain
    assert c.put("/api/presets/t/effects/bgm", json={"effects": [{"type": "nazo"}]}).status_code == 400
    assert c.put("/api/presets/t/effects/foo", json={"effects": gain}).status_code == 400
    assert c.put("/api/presets/t/effects/bgm", json={}).status_code == 400
    assert c.get("/api/project").json()["project"]["preset"] == "t"
