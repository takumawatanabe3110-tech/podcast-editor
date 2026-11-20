import io

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
