"""完成版のコピー先（deliver_dir）：番組設定の保存と、MP3 書き出し後のコピー。"""
import json
import time

import numpy as np
import pytest
import soundfile as sf

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from podcast_engine import library  # noqa: E402
from podcast_engine.project import Edit, Project, Segment, Source, Sync, Voice  # noqa: E402
from podcast_engine.server import create_app  # noqa: E402
from podcast_engine.transcribe import Transcript, Utterance  # noqa: E402

FS = 48000


def make_library(tmp_path, deliver_dir=None):
    prog = library.create_program(tmp_path, "岡田山ラジオ")
    data = library.load_program(prog)
    data["members"] = [{"name": "青木さん", "role": "mc"}, {"name": "内田さん", "role": "guest"}]
    if deliver_dir is not None:
        data["deliver_dir"] = str(deliver_dir)
    library.save_program(prog, data)
    ep = prog / "20261204"
    ep.mkdir()
    rng = np.random.default_rng(0)
    for n in ("a", "b"):
        sf.write(ep / f"{n}.wav", (rng.standard_normal(4 * FS) * 0.1).astype(np.float32), FS, subtype="FLOAT")
    Project(
        sample_rate=FS, sources={"a": Source("a.wav"), "b": Source("b.wav")}, sync=Sync("a", {}),
        voices=[Voice("a", "青木さん", 20.0), Voice("b", "内田さん", 21.0)],
        edit=Edit(position=0.0, segments=[Segment(0.5, 3.5)]),
    ).save(ep / "20261204.podproj")
    Transcript("m", "ja", [
        Utterance("S1", "a", 1.0, 2.0, "えー こんにちは", "こんにちは", []),
        Utterance("S2", "b", 2.0, 3.0, "えー", "", []),  # 台本が空なら出さない
        Utterance("S2", "b", 3.0, 3.4, "はい", "はい", []),
    ]).save(ep / "20261204.transcript.json")
    return prog, ep


def run_export(ep, name="20261204.mp3"):
    c = TestClient(create_app(ep / "20261204.podproj"))
    assert c.post("/api/export", json={"path": name}).status_code == 200
    end = time.time() + 60
    while time.time() < end:
        st = c.get("/api/export").json()
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.2)
    raise AssertionError("書き出しが終わりません")


def test_deliver_dir_roundtrips_and_is_validated(tmp_path):
    make_library(tmp_path)
    c = TestClient(create_app(library_root=tmp_path))
    prog = c.get("/api/programs/岡田山ラジオ").json()
    prog["deliver_dir"] = "~/Drive/podcast"
    r = c.put("/api/programs/岡田山ラジオ", json=prog)
    assert r.status_code == 200 and r.json()["deliver_dir"] == "~/Drive/podcast"
    assert c.get("/api/programs/岡田山ラジオ").json()["deliver_dir"] == "~/Drive/podcast"
    assert c.get("/api/library").json()["programs"][0]["deliver_dir"] == "~/Drive/podcast"
    prog["deliver_dir"] = 5
    assert c.put("/api/programs/岡田山ラジオ", json=prog).status_code == 400


def test_export_delivers_mp3_and_listen_json(tmp_path):
    dest = tmp_path / "drive" / "sub"
    _, ep = make_library(tmp_path, dest)
    st = run_export(ep)
    assert st["state"] == "done", st
    mp3 = dest / "岡田山ラジオ_2026-12-04.mp3"
    assert st["delivered"] == str(mp3)
    assert mp3.stat().st_size == (ep / "20261204.mp3").stat().st_size
    meta = json.loads((dest / "岡田山ラジオ_2026-12-04.listen.json").read_text(encoding="utf-8"))
    assert list(meta) == ["format", "version", "program", "episode", "date", "members", "speakers",
                          "duration", "audio", "exported_at", "lines"]
    assert meta["format"] == "podlisten" and meta["version"] == 1
    assert (meta["program"], meta["episode"], meta["date"]) == ("岡田山ラジオ", "20261204", "2026-12-04")
    assert meta["members"] == ["青木さん", "内田さん"]
    assert meta["speakers"] == {"青木さん": "#6AA7FF", "内田さん": "#F2A65A"}
    assert meta["duration"] == pytest.approx(st["report"]["duration"], abs=0.01)
    assert meta["audio"] == "岡田山ラジオ_2026-12-04.mp3" and meta["exported_at"].endswith("Z")
    assert meta["lines"] == [{"speaker": "青木さん", "text": "こんにちは", "start": 0.5, "end": 1.5},
                             {"speaker": "内田さん", "text": "はい", "start": 2.5, "end": 2.9}]
    assert not [f for f in dest.iterdir() if f.name.startswith(".")]  # 一時ファイルは残さない
    # もう一度書き出すと上書き
    (dest / "岡田山ラジオ_2026-12-04.listen.json").write_text("{}", encoding="utf-8")
    assert run_export(ep)["state"] == "done"
    assert json.loads((dest / "岡田山ラジオ_2026-12-04.listen.json").read_text(encoding="utf-8"))["format"] == "podlisten"


def test_no_transcript_gives_empty_lines(tmp_path):
    dest = tmp_path / "out"
    _, ep = make_library(tmp_path, dest)
    (ep / "20261204.transcript.json").unlink()
    assert run_export(ep)["state"] == "done"
    assert json.loads((dest / "岡田山ラジオ_2026-12-04.listen.json").read_text(encoding="utf-8"))["lines"] == []


def test_no_deliver_dir_writes_nothing(tmp_path):
    _, ep = make_library(tmp_path)
    st = run_export(ep)
    assert st["state"] == "done" and "delivered" not in st and "deliver_error" not in st
    assert sorted(p.name for p in tmp_path.iterdir()) == ["岡田山ラジオ"]


def test_wav_export_is_not_delivered(tmp_path):
    dest = tmp_path / "out"
    _, ep = make_library(tmp_path, dest)
    assert "delivered" not in run_export(ep, "x.wav")
    assert not dest.exists()


def test_delivery_failure_keeps_export_done(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    _, ep = make_library(tmp_path, blocker / "sub")  # フォルダを作れない
    st = run_export(ep)
    assert st["state"] == "done" and "完成版フォルダ" in st["deliver_error"] and "delivered" not in st
