import io
import json
import threading
import time

import numpy as np
import pytest
import soundfile as sf

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from podcast_engine import cli, denoise, library, presets, server, transcribe, voiceprint  # noqa: E402
from podcast_engine.project import Edit, Project, Segment, Source, Voice  # noqa: E402
from podcast_engine.server import create_app  # noqa: E402
from podcast_engine.synth import SynthTrack, make_session  # noqa: E402
from podcast_engine.transcribe import Transcript, Utterance, Word  # noqa: E402

FS = 16000
E_AOKI = np.eye(4, dtype=np.float32)[0]
E_OTHER = np.eye(4, dtype=np.float32)[1]


def make_preset_dir(tmp):
    """小さなテスト用プリセット。BGM はここに置く（番組の BGM で差し替える確認のため、わざと無い場所を指す）。"""
    d = tmp / "presets"
    d.mkdir()
    (d / "t.json").write_text(json.dumps({
        "format": "podpreset", "version": 1, "name": "t", "description": "テスト",
        "edit": {"position": 1.0},
        "voices": [
            {"name": "青木さん", "gain_db": 7.0},
            {"name": "内田さん", "gain_db": 9.0},
        ],
        "default_voice": {"name": "ゲスト", "gain_db": 3.0},
        "bgm": [
            {"source": "op", "path": "nowhere/op.wav", "anchor": "voice_start", "at": -2.0, "duration": 2.0},
            {"source": "ed", "path": "nowhere/ed.wav", "anchor": "voice_end", "at": -1.0, "duration": 2.0},
        ],
    }), encoding="utf-8")
    return d


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(presets, "PRESET_DIR", make_preset_dir(tmp_path))
    root = tmp_path / "lib"
    root.mkdir()
    return root


def tone_wav(path, seconds=2.0):
    x = (0.1 * np.sin(2 * np.pi * 440 * np.arange(int(seconds * FS)) / FS)).astype(np.float32)
    sf.write(str(path), x, FS, subtype="FLOAT")


def make_episode(pdir, eid, title=None, speakers=("青木さん", "内田さん")):
    ed = pdir / eid
    (ed / "素材").mkdir(parents=True)
    srcs, voices = {}, []
    for i, sp in enumerate(speakers):
        tone_wav(ed / "素材" / f"v{i + 1}.wav", 30.0)
        srcs[f"voice{i + 1}"] = Source(f"素材/v{i + 1}.wav")
        voices.append(Voice(f"voice{i + 1}", sp))
    p = Project(name=title or eid, sample_rate=FS, sources=srcs, voices=voices,
                edit=Edit(segments=[Segment(0.0, 20.0)]))
    p.sync.reference = "voice1"
    p.save(ed / f"{eid}.podproj")
    return ed


# ---------------------------------------------------------------- 一覧


def test_list_programs_and_episodes(env):
    d = library.create_program(env, "番組A", preset="t")
    (env / "memo").mkdir()  # program.json の無いフォルダは番組ではない
    make_episode(d, "20261120", "第1回")
    ed = make_episode(d, "20261204", "第2回")
    (ed / "20261204.mp3").write_bytes(b"x" * 10)
    (ed / "20261204.transcript.json").write_text("{}", encoding="utf-8")
    (d / "20261204x").mkdir()  # 日付の形でないフォルダは無視

    progs = library.list_programs(env)
    assert [(p["id"], p["name"], p["preset"]) for p in progs] == [("番組A", "番組A", "t")]
    eps = library.list_episodes(d)
    assert [e["id"] for e in eps] == ["20261204", "20261120"]  # 新しい順
    e = eps[0]
    assert (e["title"], e["date"], e["has_project"], e["has_transcript"]) == ("第2回", "2026-12-04", True, True)
    assert e["exported"]["size"] == 10 and e["exported"]["path"].endswith("20261204.mp3")
    assert e["duration"] == pytest.approx(20.0)
    assert eps[1]["exported"] is None and eps[1]["has_transcript"] is False

    c = TestClient(create_app(library_root=env))
    lib = c.get("/api/library").json()
    assert lib["root"] == str(env.resolve())
    assert lib["programs"][0]["id"] == "番組A"
    assert len(lib["programs"][0]["episodes"]) == 2
    assert c.get("/api/programs/番組A").json()["preset"] == "t"
    assert c.get("/api/programs/nai").status_code == 404
    assert c.get("/api/programs/..").status_code in (400, 404)


def test_create_program_endpoint(env):
    c = TestClient(create_app(library_root=env))
    r = c.post("/api/programs", json={"name": "新番組", "preset": "t"})
    assert r.status_code == 200 and (env / "新番組" / "program.json").exists()
    assert c.post("/api/programs", json={"name": "新番組"}).status_code == 409
    assert c.post("/api/programs", json={"name": "../x"}).status_code == 400
    assert c.post("/api/programs", json={}).status_code == 400


# ---------------------------------------------------------------- 番組の保存・検証


def test_program_validation_and_put(env):
    d = library.create_program(env, "P")
    base = library.load_program(d)
    good = {**base, "bgm": {"op": "BGM/a.mp3"}, "members": [{"name": "青木さん", "role": "mc"}]}
    assert library.validate_program(good, d) is good
    for bad in (
        {**base, "format": "x"},
        {**base, "name": ""},
        {**base, "bgm": {"op": "../x.mp3"}},
        {**base, "bgm": {"op": "/etc/passwd"}},
        {**base, "bgm": {"op": "BGM/../../x.mp3"}},
        {**base, "members": [{"name": "A", "voiceprint": "../p.npz"}]},
        {**base, "members": [{"name": "A", "role": "boss"}]},
        {**base, "members": [{"name": "A"}, {"name": "A"}]},
        {**base, "members": [{"name": "../A"}]},
    ):
        with pytest.raises(ValueError):
            library.validate_program(bad, d)

    c = TestClient(create_app(library_root=env))
    r = c.put("/api/programs/P", json={**good, "members": [{"name": "青木さん", "role": "guest", "enrolled": False}]})
    assert r.status_code == 200
    saved = json.loads((d / "program.json").read_text(encoding="utf-8"))
    assert saved["members"] == [{"name": "青木さん", "role": "guest"}]  # enrolled は保存しない
    assert "青木さん" in (d / "program.json").read_text(encoding="utf-8")  # ensure_ascii False
    r = c.put("/api/programs/P", json={**good, "bgm": {"op": "../escape.mp3"}})
    assert r.status_code == 400 and "外" in r.json()["detail"]
    assert json.loads((d / "program.json").read_text(encoding="utf-8")) == saved  # 変わっていない


def test_bgm_upload(env):
    d = library.create_program(env, "P")
    c = TestClient(create_app(library_root=env))
    r = c.post("/api/programs/P/bgm", data={"role": "op"}, files={"file": ("opening.mp3", b"abc", "audio/mpeg")})
    assert r.status_code == 200 and r.json()["path"] == "BGM/opening.mp3"
    assert (d / "BGM" / "opening.mp3").read_bytes() == b"abc"
    assert library.load_program(d)["bgm"] == {"op": "BGM/opening.mp3"}
    r = c.post("/api/programs/P/bgm", data={"role": "op"}, files={"file": ("../evil.mp3", b"abc")})
    assert r.status_code == 400 or (d / "BGM" / "evil.mp3").exists()
    assert not (d / "evil.mp3").exists()


# ---------------------------------------------------------------- 移行（library-init）


def test_library_init_migration(env, tmp_path, capsys):
    pdir = tmp_path / "presets"
    (pdir / "BGM").mkdir()
    tone_wav(pdir / "BGM" / "Open (1).wav")
    tone_wav(pdir / "BGM" / "End.wav")
    spec = json.loads((pdir / "t.json").read_text(encoding="utf-8"))
    spec["bgm"][0]["path"] = "BGM/Open (1).wav"
    spec["bgm"][1]["path"] = "BGM/End.wav"
    (pdir / "t.json").write_text(json.dumps(spec), encoding="utf-8")
    (env / "岡田山ラジオ" / "20261204").mkdir(parents=True)  # 既にある番組フォルダ

    assert cli.main(["library-init", "--library", str(env), "--preset", "t"]) == 0
    d = env / "岡田山ラジオ"
    prog = json.loads((d / "program.json").read_text(encoding="utf-8"))
    assert prog["format"] == "podprogram" and prog["preset"] == "t"
    assert prog["bgm"] == {"op": "BGM/Open (1).wav", "ed": "BGM/End.wav"}
    assert (d / "BGM" / "Open (1).wav").is_file() and (d / "BGM" / "End.wav").is_file()
    assert [(m["name"], m["role"]) for m in prog["members"]] == [("青木さん", "mc"), ("内田さん", "mc")]
    assert all("voiceprint" not in m for m in prog["members"])
    # もう一度やっても上書きしない
    prog["members"].append({"name": "X", "role": "guest"})
    library.save_program(d, prog)
    assert cli.main(["library-init", "--library", str(env), "--preset", "t"]) == 0
    assert len(library.load_program(d)["members"]) == 3


# ---------------------------------------------------------------- 開く・現在のエピソード


def test_open_and_current_switching(env):
    d = library.create_program(env, "P")
    make_episode(d, "20261120", "第1回")
    make_episode(d, "20261204", "第2回")
    (d / "20261001").mkdir()  # プロジェクトの無い日
    c = TestClient(create_app(library_root=env))
    assert c.get("/api/current").json() is None
    assert c.get("/api/project").status_code == 404
    assert c.post("/api/open", json={"program": "P", "episode": "20261001"}).status_code == 404
    assert c.post("/api/open", json={"program": "nai", "episode": "20261120"}).status_code == 404
    assert c.post("/api/open", json={"program": "P", "episode": "../P"}).status_code == 400

    assert c.post("/api/open", json={"program": "P", "episode": "20261120"}).json() == {"program": "P", "episode": "20261120"}
    assert c.get("/api/current").json() == {"program": "P", "episode": "20261120"}
    assert c.get("/api/project").json()["project"]["name"] == "第1回"
    assert c.get("/api/project").json()["name"] == "20261120.podproj"
    assert c.get("/api/peaks/voice1").status_code == 200

    c.post("/api/open", json={"program": "P", "episode": "20261204"})
    assert c.get("/api/project").json()["project"]["name"] == "第2回"
    p = c.get("/api/project").json()["project"]
    p["name"] = "改名"
    assert c.put("/api/project", json=p).status_code == 200  # 保存先も今のエピソード
    assert Project.load(d / "20261204" / "20261204.podproj").name == "改名"
    assert Project.load(d / "20261120" / "20261120.podproj").name == "第1回"


def test_serve_project_opens_it_and_guesses_library(env):
    d = library.create_program(env, "P")
    make_episode(d, "20261204", "第2回")
    app = create_app(d / "20261204" / "20261204.podproj")  # library は指定しない
    c = TestClient(app)
    assert c.get("/api/current").json() == {"program": "P", "episode": "20261204"}
    assert c.get("/api/library").json()["root"] == str(env.resolve())
    assert c.get("/api/project").json()["project"]["name"] == "第2回"
    assert server.guess_library(d / "20261204" / "20261204.podproj") == env


# ---------------------------------------------------------------- 声紋の登録


def test_enroll_voiceprint(env, monkeypatch):
    d = library.create_program(env, "P")
    ed = make_episode(d, "20261204")
    calls = []

    def fake_track(path, fs_hint=None, segments=None, max_seconds=120):
        calls.append({"path": str(path), "segments": segments})
        return E_AOKI

    monkeypatch.setattr(voiceprint, "track_embedding", fake_track)
    c = TestClient(create_app(library_root=env))
    r = c.post("/api/programs/P/members/青木さん/voiceprint", json={"episode": "20261204", "source": "voice2"})
    assert r.status_code == 200
    assert r.json() == {"name": "青木さん", "role": "mc", "voiceprint": "声紋/青木さん.npz"}
    emb, meta = voiceprint.load_print(d / "声紋" / "青木さん.npz")
    assert np.allclose(emb, E_AOKI)
    assert (meta["name"], meta["episode"], meta["source"]) == ("青木さん", "20261204", "voice2")
    assert meta["seconds"] == pytest.approx(30.0)
    assert library.load_program(d)["members"] == [r.json()]
    assert calls[-1]["segments"] is None and calls[-1]["path"].endswith("v2.wav")  # 除去済みが無いので元の素材

    # 文字起こしがあれば、その人の発言の区間（ファイル時刻）を使う。同期のずれも反映
    p = Project.load(ed / "20261204.podproj")
    from podcast_engine.project import TrackOffset

    p.sync.tracks["voice2"] = TrackOffset(2.0, 0.0, "clap")
    p.save(ed / "20261204.podproj")
    Transcript("m", "ja", [
        Utterance("青木さん", "voice1", 0, 3, "a", "a"),
        Utterance("内田さん", "voice2", 1.0, 6.0, "b", "b"),
        Utterance("内田さん", "voice2", 10.0, 18.0, "c", "c"),
    ]).save(ed / "20261204.transcript.json")
    r = c.post("/api/programs/P/members/内田さん/voiceprint",
               json={"episode": "20261204", "source": "voice2", "role": "guest"})
    assert r.json()["role"] == "guest"
    assert calls[-1]["segments"] == [(12.0, 20.0), (3.0, 8.0)]  # 長い順、+2 秒ずらし
    # 同じメンバーを撮り直しても増えない
    c.post("/api/programs/P/members/内田さん/voiceprint", json={"episode": "20261204", "source": "voice2"})
    mem = library.load_program(d)["members"]
    assert [m["name"] for m in mem] == ["青木さん", "内田さん"] and mem[1]["role"] == "guest"

    assert c.post("/api/programs/P/members/X/voiceprint", json={"episode": "20261204", "source": "nai"}).status_code == 404
    assert c.post("/api/programs/P/members/X/voiceprint", json={"episode": "99999999", "source": "voice1"}).status_code == 404
    assert c.post("/api/programs/P/members/..x/voiceprint", json={"episode": "20261204", "source": "voice1"}).status_code in (400, 404)

    assert c.delete("/api/programs/P/members/内田さん").status_code == 200
    assert not (d / "声紋" / "内田さん.npz").exists()
    assert [m["name"] for m in library.load_program(d)["members"]] == ["青木さん"]
    assert c.delete("/api/programs/P/members/内田さん").status_code == 404


def test_enroll_uses_denoised_cache_if_present(env, monkeypatch):
    d = library.create_program(env, "P")
    ed = make_episode(d, "20261204")
    p = Project.load(ed / "20261204.podproj")
    p.voices[0].denoise = {"method": "deepfilternet", "atten_lim_db": None}
    p.save(ed / "20261204.podproj")
    src = ed / "素材" / "v1.wav"
    cache = ed / ".podcache"
    cache.mkdir()
    den = cache / f"v1.denoise-{denoise._cache_key(src, p.voices[0].denoise)}.wav"
    tone_wav(den)
    seen = []
    monkeypatch.setattr(voiceprint, "track_embedding", lambda path, **kw: seen.append(path) or E_AOKI)
    library.enroll_voiceprint(d, "青木さん", "20261204", "voice1")
    assert seen[-1] == den


# ---------------------------------------------------------------- エピソードを作る


def wav_bytes(x):
    b = io.BytesIO()
    sf.write(b, x, FS, format="WAV", subtype="FLOAT")
    return b.getvalue()


@pytest.fixture
def job_env(env, monkeypatch):
    """重い処理（ノイズ除去・声紋・文字起こし）は差し替える。同期は合成の素材で本物を動かす。"""
    d = library.create_program(env, "番組", preset="t")
    tone_wav(d / "BGM" / "op.wav")
    tone_wav(d / "BGM" / "ed.wav")
    prog = library.load_program(d)
    prog["bgm"] = {"op": "BGM/op.wav", "ed": "BGM/ed.wav"}
    prog["members"] = [{"name": "青木さん", "role": "mc"}, {"name": "内田さん", "role": "mc"}]
    library.save_program(d, prog)
    voiceprint.save_print(d / "声紋" / "青木さん.npz", E_AOKI, {"name": "青木さん"})
    prog["members"][0]["voiceprint"] = "声紋/青木さん.npz"  # 内田さんは声紋なし
    library.save_program(d, prog)

    denoised = []
    monkeypatch.setattr(denoise, "denoised_path", lambda src, params, cache: denoised.append(src) or src)
    # a.wav は知らない人、b.wav が青木さんの声
    monkeypatch.setattr(voiceprint, "track_embedding",
                        lambda path, **kw: E_AOKI if str(path).endswith("b.wav") else E_OTHER)

    def fake_transcribe(project, base, prompt=None, log=lambda s: None):
        for v in project.voices:
            log(f"{v.name}：文字起こし中…")
        v = project.voices[0]
        return Transcript("m", "ja", [Utterance(v.name, v.source, 10.0, 12.0, "こんにちは", "こんにちは", [Word(10.0, 12.0, "こんにちは")])])

    monkeypatch.setattr(transcribe, "transcribe_project", fake_transcribe)
    waves = make_session([SynthTrack(0.0), SynthTrack(1.0)], fs=FS, duration=20, clap_at=5.0, false_transient_at=None)
    return TestClient(create_app(library_root=env)), d, waves, denoised


def wait_status(c, prog, eid, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = c.get(f"/api/programs/{prog}/episodes/{eid}/status").json()
        if st["state"] not in ("queued", "running"):
            return st
        time.sleep(0.05)
    raise AssertionError("終わらない")


def post_episode(c, waves, date="20261204", prog="番組", names=("a.wav", "b.wav")):
    files = [("files", (n, wav_bytes(w), "audio/wav")) for n, w in zip(names, waves)]
    return c.post(f"/api/programs/{prog}/episodes", data={"date": date}, files=files)


def test_episode_creation_end_to_end(job_env):
    c, d, waves, denoised = job_env
    r = post_episode(c, [waves[1], waves[0]], names=("b.wav", "a.wav"))  # 順番は問わない（名前順に並べ直す）
    assert r.status_code == 200 and r.json()["episode"] == "20261204"
    st = wait_status(c, "番組", "20261204")
    assert st["state"] == "done", st
    assert st["progress"] == 1.0 and st["remaining"] is None

    ed = d / "20261204"
    assert (ed / "素材" / "a.wav").is_file() and (ed / "素材" / "b.wav").is_file()
    p = Project.load(ed / "20261204.podproj")
    assert p.name == "番組 2026-12-04"
    assert [v.name for v in p.voices] == ["ゲスト", "青木さん"]  # a=知らない人、b=青木さん
    assert [v.gain_db for v in p.voices] == [3.0, 7.0]  # 名前でプリセットの設定が当たる（青木さん 7、ゲストは default 3）
    assert p.preset == "t"
    # BGM は番組の BGM に差し替わる
    assert p.source_path("op", ed).resolve() == (d / "BGM" / "op.wav").resolve()
    assert p.source_path("ed", ed).resolve() == (d / "BGM" / "ed.wav").resolve()
    assert len(denoised) >= 2
    # 文字起こしと波形のキャッシュ
    assert (ed / "20261204.transcript.json").is_file() and (ed / "20261204.transcript.txt").is_file()
    assert list((ed / ".podcache").glob("*.peaks-*.json"))
    assert list((ed / ".podcache").glob("*.preview-*.wav"))
    # 一覧と開く
    eps = c.get("/api/library").json()["programs"][0]["episodes"]
    assert eps[0]["id"] == "20261204" and eps[0]["has_transcript"] and eps[0]["has_project"]
    assert c.post("/api/open", json={"program": "番組", "episode": "20261204"}).status_code == 200
    assert c.get("/api/transcript").status_code == 200
    # 同じ日をもう一度は 409
    assert post_episode(c, waves).status_code == 409


def test_episode_without_voiceprints_keeps_preset_order(job_env, monkeypatch):
    c, d, waves, _ = job_env
    prog = library.load_program(d)
    prog["members"] = [{"name": "青木さん", "role": "mc"}]  # 声紋なし
    library.save_program(d, prog)
    (d / "声紋" / "青木さん.npz").unlink()
    assert post_episode(c, waves, date="20261211").status_code == 200
    assert wait_status(c, "番組", "20261211")["state"] == "done"
    p = Project.load(d / "20261211" / "20261211.podproj")
    assert [v.name for v in p.voices] == ["青木さん", "内田さん"]  # 声紋がなければ従来どおり、プリセットの順
    assert [v.gain_db for v in p.voices] == [7.0, 9.0]


def test_guest_numbering(job_env, monkeypatch):
    c, d, waves, _ = job_env
    monkeypatch.setattr(voiceprint, "track_embedding", lambda path, **kw: E_OTHER)
    assert post_episode(c, waves, date="20261218").status_code == 200
    assert wait_status(c, "番組", "20261218")["state"] == "done"
    p = Project.load(d / "20261218" / "20261218.podproj")
    assert [v.name for v in p.voices] == ["ゲスト", "ゲスト2"]
    assert [v.gain_db for v in p.voices] == [3.0, 3.0]


def test_episode_error_is_reported(job_env, monkeypatch):
    c, d, waves, _ = job_env

    def boom(*a, **k):
        raise RuntimeError("壊れた")

    monkeypatch.setattr(transcribe, "transcribe_project", boom)
    assert post_episode(c, waves, date="20261225").status_code == 200
    st = wait_status(c, "番組", "20261225")
    assert st["state"] == "error" and "壊れた" in st["message"]
    # 失敗のあとは次を始められる
    monkeypatch.setattr(server, "build_episode", lambda *a, **k: None)
    assert post_episode(c, waves, date="20261226").status_code == 200


def test_episode_bad_requests(job_env):
    c, d, waves, _ = job_env
    assert post_episode(c, waves, date="2026-12-04").status_code == 400
    assert post_episode(c, waves, date="20261301").status_code == 400
    r = c.post("/api/programs/番組/episodes", data={"date": "20261204"},
               files=[("files", ("a.wav", wav_bytes(waves[0]), "audio/wav"))])
    assert r.status_code == 400  # 1本だけ
    assert post_episode(c, waves, names=("a.wav", "a.wav")).status_code == 400
    assert post_episode(c, waves, names=("a.mp3", "b.wav")).status_code == 400
    assert post_episode(c, waves, prog="nai").status_code == 404
    assert c.get("/api/programs/番組/episodes/20261204/status").status_code == 404
    assert not (d / "20261204").exists()


def slow_build(gate, started=None, order=None):
    """gate が開くまで終わらない、差し替え用の build_episode。"""
    def slow(program_dir, date, files, progress, log=lambda s: None, **kw):
        if order is not None:
            order.append(date)
        if started is not None:
            started.set()
        progress(0.5, "途中")
        gate.wait(30)
        return program_dir / date / f"{date}.podproj"
    return slow


def test_episode_jobs_queue_fifo(job_env, monkeypatch):
    c, d, waves, _ = job_env
    gate, started, order = threading.Event(), threading.Event(), []
    monkeypatch.setattr(server, "build_episode", slow_build(gate, started, order))
    r1 = post_episode(c, waves, date="20261204")
    assert r1.status_code == 200 and r1.json()["state"] == "queued"
    assert started.wait(10)
    r2 = post_episode(c, waves, date="20261211")  # 2本目は 409 ではなく順番待ち
    assert r2.status_code == 200 and r2.json()["position"] == 1
    st1 = c.get("/api/programs/番組/episodes/20261204/status").json()
    assert st1["state"] == "running" and st1["stage"] == "途中" and st1["progress"] == 0.5 and st1["review"] == []
    st2 = c.get("/api/programs/番組/episodes/20261211/status").json()
    assert st2["state"] == "queued" and st2["position"] == 1
    assert (d / "20261211" / "素材" / "a.wav").is_file()  # 素材は受け取った時点で保存
    # /api/jobs
    jb = c.get("/api/jobs").json()
    assert jb["running"]["program"] == "番組" and jb["running"]["episode"] == "20261204"
    assert jb["running"]["stage"] == "途中" and jb["running"]["progress"] == 0.5 and "remaining" in jb["running"]
    assert jb["queued"] == [{"program": "番組", "episode": "20261211", "position": 1}]
    # 一覧に job が入る
    eps = {e["id"]: e for e in c.get("/api/library").json()["programs"][0]["episodes"]}
    assert eps["20261204"]["job"]["state"] == "running" and eps["20261204"]["job"]["progress"] == 0.5
    assert eps["20261204"]["job"]["stage"] == "途中"  # 一覧のカードに「処理中 ・ 途中」と出す
    assert eps["20261211"]["job"] == {"state": "queued", "position": 1}
    # 同じ日は 409（実行中も順番待ちも）
    assert post_episode(c, waves, date="20261204").status_code == 409
    assert post_episode(c, waves, date="20261211").status_code == 409
    gate.set()
    assert wait_status(c, "番組", "20261211")["state"] == "done"
    assert order == ["20261204", "20261211"]
    assert c.get("/api/jobs").json() == {"running": None, "queued": []}


def test_cancel_queued_job(job_env, monkeypatch):
    c, d, waves, _ = job_env
    gate, started = threading.Event(), threading.Event()
    monkeypatch.setattr(server, "build_episode", slow_build(gate, started))
    assert post_episode(c, waves, date="20261204").status_code == 200
    assert started.wait(10)
    assert post_episode(c, waves, date="20261211").status_code == 200
    assert c.delete("/api/programs/番組/episodes/20261204/job").status_code == 409  # 実行中は不可
    assert c.delete("/api/programs/番組/episodes/20261211/job").status_code == 200
    assert c.delete("/api/programs/番組/episodes/20261211/job").status_code == 404
    assert c.get("/api/jobs").json()["queued"] == []
    assert c.get("/api/programs/番組/episodes/20261211/status").json()["state"] == "idle"
    assert (d / "20261211" / "素材" / "a.wav").is_file()  # 素材は残す
    gate.set()
    assert wait_status(c, "番組", "20261204")["state"] == "done"
    assert post_episode(c, waves, date="20261211").status_code == 200  # 取り消した日はまた入れられる
    wait_status(c, "番組", "20261211")


def test_names_and_title_are_passed(job_env, monkeypatch):
    c, d, waves, _ = job_env
    seen = {}

    def fake(program_dir, date, files, progress, log=lambda s: None, names=None, title=None):
        seen.update(files=[f.name for f in files], names=names, title=title)

    monkeypatch.setattr(server, "build_episode", fake)
    files = [("files", (n, wav_bytes(w), "audio/wav")) for n, w in zip(("b.wav", "a.wav"), waves)]
    r = c.post("/api/programs/番組/episodes", files=files,
               data={"date": "20261204", "names": json.dumps(["青木さん", ""]), "title": "特別回"})
    assert r.status_code == 200
    wait_status(c, "番組", "20261204")
    assert seen == {"files": ["a.wav", "b.wav"], "names": ["voice1", "青木さん"], "title": "特別回"}  # 名前順に並べ直しても対応は保つ
    bad = c.post("/api/programs/番組/episodes", files=files, data={"date": "20261211", "names": json.dumps(["x"])})
    assert bad.status_code == 400


def _review_env(tmp_path, findings, with_print=True):
    """番組・エピソード・review.json だけの最小の環境（モデル不要）。"""
    d = tmp_path / "番組"
    d.mkdir(parents=True)
    (d / "program.json").write_text(json.dumps({
        "format": library.PROGRAM_FORMAT, "version": 1, "name": "番組", "preset": "", "bgm": {},
        "members": [{"name": "青木さん", "role": "mc", **({"voiceprint": "声紋/青木さん.npz"} if with_print else {})}],
    }, ensure_ascii=False), encoding="utf-8")
    if with_print:
        voiceprint.save_print(d / "声紋" / "青木さん.npz", E_AOKI, {"name": "青木さん", "episode": "20261127", "seconds": 60.0})
    ed = d / "20261204"
    ed.mkdir()
    (ed / "20261204.podproj").write_text("{}", encoding="utf-8")
    library.save_review(ed, findings)
    return d, ed


def test_review_notes_learning_and_hints(tmp_path, monkeypatch):
    weak = library._finding("weak_match", "A は 青木さん と判定しましたが点数が低めです（0.80）", source="a", name="青木さん")
    other = library._finding("no_clap", "拍手なし", 12.5)
    d, ed = _review_env(tmp_path, [weak, other])

    # note の引き継ぎ
    old = [dict(other, note="いつもこう", resolved=True)]
    new = library._carry_resolved([library._finding("no_clap", "拍手なし", 12.5)], old)
    assert new[0]["note"] == "いつもこう" and new[0]["resolved"] is True
    assert library._finding("x", "m", source="s")["source"] == "s"

    # 学習：ログと声紋の補強（埋め込みは固定値）
    e2 = np.array([0, 1, 0, 0], dtype=np.float32)
    monkeypatch.setattr(library, "_track_embedding_for", lambda *a, **k: (e2, 30.0))
    msg = library.learn_from_review(d, "20261204", dict(weak, note="本人でした"))
    assert msg == "青木さんの声紋に 12/4 の声を足しました（2 回分）"
    emb, meta = voiceprint.load_print(d / "声紋" / "青木さん.npz")
    assert meta["count"] == 2 and meta["episodes"] == ["20261127", "20261204"] and meta["seconds"] == 90.0
    assert np.allclose(emb, voiceprint._unit(E_AOKI + e2), atol=1e-6)
    msg = library.learn_from_review(d, "20261211", dict(weak))
    assert "3 回分" in msg
    # 弱い一致でないものはログだけ
    assert library.learn_from_review(d, "20261204", dict(other, note="メモ")) is None
    log = [json.loads(x) for x in (d / "review_log.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(log) == 3 and log[0]["note"] == "本人でした" and log[0]["name"] == "青木さん" and log[2]["kind"] == "no_clap"
    # 声紋がなければログだけで None
    d2, _ = _review_env(tmp_path / "x", [weak], with_print=False)
    assert library.learn_from_review(d2, "20261204", dict(weak)) is None
    assert (d2 / "review_log.jsonl").is_file()

    # ヒント：別のエピソードの同じ種類のメモ
    fs = [library._finding("no_clap", "拍手なし"), library._finding("guest", "g")]
    library.attach_hints(d, "20261211", fs)
    assert fs[0]["hints"] == [{"episode": "20261204", "note": "メモ"}] and "hints" not in fs[1]
    fs2 = [library._finding("no_clap", "拍手なし")]
    library.attach_hints(d, "20261204", fs2)  # 同じエピソードは除く
    assert "hints" not in fs2[0]
    assert [e["note"] for e in library.past_notes(d, "no_clap")] == ["メモ"]

    # 引き継ぎ文
    f = library.load_review(ed)
    f[1]["note"] = "要確認メモ"
    f[1]["hints"] = [{"episode": "20261127", "note": "前回の話"}]
    library.save_review(ed, f)
    txt = library.review_handoff_text(d, "20261204")
    assert "要確認メモ" in txt and "前回の話" in txt and str(ed / "review.json") in txt
    assert "未確認" in txt and "0:12.5" in txt and "review_log.jsonl" in txt


def test_review_put_items_form(tmp_path, monkeypatch):
    weak = library._finding("weak_match", "弱い", source="a", name="青木さん")
    d, ed = _review_env(tmp_path, [weak, library._finding("no_clap", "拍手なし")])
    monkeypatch.setattr(library, "_track_embedding_for", lambda *a, **k: (np.array([0, 1, 0, 0], dtype=np.float32), 10.0))
    c = TestClient(create_app(library_root=tmp_path))
    url = "/api/programs/番組/episodes/20261204/review"
    r = c.put(url, json={"items": [{"index": 0, "resolved": True, "note": "本人"}, {"index": 1, "note": "メモのみ"}]})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["findings"][0]["resolved"] is True and j["findings"][0]["note"] == "本人"
    assert "resolved" not in j["findings"][1] and j["findings"][1]["note"] == "メモのみ"
    assert len(j["learned"]) == 1 and "青木さん" in j["learned"][0]
    # すでに確認済みなら再学習しない
    r = c.put(url, json={"items": [{"index": 0, "resolved": True}]})
    assert r.json()["learned"] == []
    # 戻す
    r = c.put(url, json={"items": [{"index": 0, "resolved": False}]})
    assert "resolved" not in r.json()["findings"][0]
    assert library.load_review(ed)[1]["note"] == "メモのみ"
    for bad in ({"items": [{"index": 9}]}, {"items": [{"index": "0"}]}, {"items": "x"},
                {"items": [{"index": 0, "resolved": "yes"}]}, {"items": [{"index": 0, "note": 5}]},
                {"items": [{"index": 0, "note": "あ" * 2001}]}):
        assert c.put(url, json=bad).status_code == 400, bad
    # 旧形式
    r = c.put(url, json={"resolved": [1]})
    assert r.json()["findings"][1]["resolved"] is True
    h = c.get(url + "/handoff").json()["text"]
    assert "メモのみ" in h and "review.json" in h


def test_review_written_with_no_clap_and_guest(job_env, monkeypatch):
    from podcast_engine import sync

    c, d, waves, _ = job_env
    real = sync.sync_tracks

    def no_clap(*a, **k):
        r = real(*a, **k)
        r.clap_time_ref_sec = None
        return r

    monkeypatch.setattr(sync, "sync_tracks", no_clap)
    assert post_episode(c, waves).status_code == 200
    st = wait_status(c, "番組", "20261204")
    assert st["state"] == "done", st
    saved = json.loads((d / "20261204" / "review.json").read_text(encoding="utf-8"))
    kinds = [f["kind"] for f in saved]
    assert "no_clap" in kinds and "guest" in kinds
    guest = next(f for f in saved if f["kind"] == "guest")
    assert "青木さん" in guest["message"] and "0.90" in guest["message"] and guest["time"] is None
    assert st["review"] == saved
    ep = c.get("/api/library").json()["programs"][0]["episodes"][0]
    assert ep["review"] == saved and ep["review_open"] == len(saved)
    # 解決済みにする
    i = kinds.index("no_clap")
    r = c.put("/api/programs/番組/episodes/20261204/review", json={"resolved": [i]})
    assert r.status_code == 200 and r.json()["findings"][i]["resolved"] is True and r.json()["learned"] == []
    ep = c.get("/api/library").json()["programs"][0]["episodes"][0]
    assert ep["review_open"] == len(saved) - 1
    assert c.put("/api/programs/番組/episodes/20261204/review", json={"resolved": [99]}).status_code == 400
    assert c.put("/api/programs/番組/episodes/20261204/review", json={"resolved": "x"}).status_code == 400
    # 作り直しても、拍手なし（同期由来）と解決済みの印は残る
    r = c.post("/api/programs/番組/episodes/20261204/review")
    assert r.status_code == 200
    again = r.json()
    assert any(f["kind"] == "no_clap" and f.get("resolved") for f in again)
    assert any(f["kind"] == "guest" for f in again)
    assert c.post("/api/programs/番組/episodes/20261299/review").status_code == 404


def U(speaker, start, end, text, source=None):
    ws = [Word(start, end, text)]
    return Utterance(speaker, source or speaker, start, end, text, text, ws)


def test_tail_chatter_heuristic():
    tf = library.tail_chatter_finding
    # 同じ発言の中で挨拶の後に続く
    tr = Transcript("m", "ja", [U("a", 0, 5, "今日の話でした"), U("a", 6, 12, "ありがとうございましたそれでは来週の話ですが")])
    f = tf(tr)
    assert f["kind"] == "tail_chatter" and f["time"] == 12.0 or f["time"] is not None
    assert "ありがとうございました" in f["message"]
    # 挨拶の直後（5秒以内）に別の発言が始まる
    tr = Transcript("m", "ja", [U("a", 0, 5, "ありがとうございました"), U("b", 7, 9, "それでね実は")])
    f = tf(tr)
    assert f["time"] == 5.0
    # 双方の挨拶だけなら問題なし
    tr = Transcript("m", "ja", [U("a", 0, 5, "ありがとうございました。"), U("b", 6, 8, "さよなら")])
    assert tf(tr) is None
    # 5秒以上空いていれば問題なし（TAIL_NEXT_SEC）
    tr = Transcript("m", "ja", [U("a", 0, 5, "ありがとうございました"), U("b", 11, 12, "それでね")])
    assert tf(tr) is None
    # 挨拶がなければ問題なし
    assert tf(Transcript("m", "ja", [U("a", 0, 5, "こんにちは"), U("b", 6, 8, "どうも")])) is None


def test_speaker_imbalance_finding():
    p = Project(name="x", sample_rate=FS, sources={"voice1": Source("a.wav"), "voice2": Source("b.wav")},
                voices=[Voice("voice1", "青木さん"), Voice("voice2", "内田さん")])
    tr = Transcript("m", "ja", [U("青木さん", 0, 100, "あ", "voice1"), U("内田さん", 100, 105, "い", "voice2")])
    f = library.imbalance_findings(tr, p)
    assert len(f) == 1 and f[0]["kind"] == "speaker_imbalance" and "内田さん" in f[0]["message"]
    tr = Transcript("m", "ja", [U("青木さん", 0, 100, "あ", "voice1"), U("内田さん", 100, 150, "い", "voice2")])
    assert library.imbalance_findings(tr, p) == []


def test_apply_preset_by_name_unit(tmp_path):
    spec, _ = presets.load_preset(str(make_preset_dir(tmp_path) / "t.json"))
    spec = {k: v for k, v in spec.items() if k != "bgm"}
    p = Project(sample_rate=FS, voices=[Voice("a", "内田さん"), Voice("b", "ゲスト2")])
    presets.apply_preset(p, spec, tmp_path, tmp_path, names_given=True, voices_by_name=True)
    assert [v.name for v in p.voices] == ["内田さん", "ゲスト2"]  # 名前は書き換えない
    assert [v.gain_db for v in p.voices] == [9.0, 3.0]
    # 従来（順番）
    q = Project(sample_rate=FS, voices=[Voice("a", "x"), Voice("b", "y")])
    presets.apply_preset(q, spec, tmp_path, tmp_path)
    assert [(v.name, v.gain_db) for v in q.voices] == [("青木さん", 7.0), ("内田さん", 9.0)]


def test_episode_export_audio_endpoint(tmp_path):
    """書き出した mp3 を一覧から聴ける（なければ 404、名前のおかしいものは 400）"""
    from fastapi.testclient import TestClient
    from podcast_engine.server import create_app

    prog = tmp_path / "番組"
    (prog / "20261204").mkdir(parents=True)
    (prog / "program.json").write_text('{"format": "podprogram", "version": 1, "name": "番組", "members": []}', encoding="utf-8")
    c = TestClient(create_app(library_root=tmp_path))
    assert c.get("/api/programs/番組/episodes/20261204/audio").status_code == 404
    (prog / "20261204" / "20261204.mp3").write_bytes(b"ID3fake")
    r = c.get("/api/programs/番組/episodes/20261204/audio")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content == b"ID3fake"
    assert c.get("/api/programs/番組/episodes/..%2F..%2Fx/audio").status_code in (400, 404)


def _transcript_fixture(tmp_path, with_transcript=True):
    from podcast_engine.project import Edit
    from podcast_engine.transcribe import Transcript, Utterance

    prog = tmp_path / "番組"
    ep = prog / "20261204"
    ep.mkdir(parents=True)
    (prog / "program.json").write_text('{"format": "podprogram", "version": 1, "name": "番組", "members": []}', encoding="utf-8")
    p = Project(sample_rate=FS, sources={"voice1": Source("a.wav")}, voices=[Voice("voice1", "青木さん")],
                edit=Edit(position=5.0, segments=[Segment(0, 10), Segment(20, 30)], crossfade_ms=0))
    p.save(ep / "20261204.podproj")
    if with_transcript:
        us = [Utterance("voice1", "voice1", 1, 3, "はじめ", "はじめ"),
              Utterance("voice1", "voice1", 12, 18, "カット中", "カット中"),
              Utterance("voice1", "voice1", 8, 22, "またぎ", "またぎ"),
              Utterance("voice1", "voice1", 25, 28, "あと", "あと")]
        Transcript("m", "ja", us).save(ep / "20261204.transcript.json")
    return prog


def test_episode_transcript_endpoint(tmp_path):
    """文字起こしは書き出し音声の時刻になる（頭の BGM 分のずれ・カットを反映）"""
    from fastapi.testclient import TestClient
    from podcast_engine.server import create_app

    _transcript_fixture(tmp_path)
    c = TestClient(create_app(library_root=tmp_path))
    r = c.get("/api/programs/番組/episodes/20261204/transcript")
    assert r.status_code == 200
    j = r.json()
    assert j["duration"] == 25.0
    assert j["lines"] == [
        {"speaker": "青木さん", "text": "はじめ", "start": 6.0, "end": 8.0},
        {"speaker": "青木さん", "text": "またぎ", "start": 13.0, "end": 17.0},
        {"speaker": "青木さん", "text": "あと", "start": 20.0, "end": 23.0},
    ]


def test_episode_transcript_endpoint_errors(tmp_path):
    from fastapi.testclient import TestClient
    from podcast_engine.server import create_app

    _transcript_fixture(tmp_path, with_transcript=False)
    (tmp_path / "番組" / "20261205").mkdir()
    c = TestClient(create_app(library_root=tmp_path))
    assert c.get("/api/programs/番組/episodes/20261204/transcript").status_code == 404  # 文字起こしなし
    assert c.get("/api/programs/番組/episodes/20261205/transcript").status_code == 404  # プロジェクトなし
    assert c.get("/api/programs/番組/episodes/..%2Fx/transcript").status_code in (400, 404)


def test_auto_export_writes_finished_mp3(tmp_path):
    """回ができたら、いったん完成版の MP3 を書き出し、一覧で「書き出し済み」として聴ける"""
    prog = _transcript_fixture(tmp_path)
    ep = prog / "20261204"
    t = np.arange(int(FS * 30)) / FS
    sf.write(str(ep / "a.wav"), (0.1 * np.sin(2 * np.pi * 220 * t)).astype("float32"), FS, subtype="FLOAT")
    p = Project.load(ep / "20261204.podproj")
    p.sync.reference = "voice1"
    p.save(ep / "20261204.podproj")
    seen = []
    assert server.auto_export(ep / "20261204.podproj", lambda f, s: seen.append(f)) == []
    assert (ep / "20261204.mp3").is_file()
    assert seen and min(seen) >= 0.88 and max(seen) <= 1.0
    c = TestClient(create_app(library_root=tmp_path))
    e = next(x for x in c.get("/api/library").json()["programs"][0]["episodes"] if x["id"] == "20261204")
    assert e["exported"]
    assert c.get("/api/programs/番組/episodes/20261204/audio").headers["content-type"] == "audio/mpeg"
    # 書き出しで測った大きさ（フェーダーを除く）が残り、編集画面の試聴の音量合わせに使える
    ws = server.Workspace(ep / "20261204.podproj")
    off = ws.preview_offset_db()
    assert off is not None and -60 < off < 0
    assert ws.derived(ws.load())["preview_offset_db"] == off


def test_fader_basis_matches_ui():
    """試聴の基準（声のフェーダーの平均＋マスター）。画面の faderBasisDb と同じ計算"""
    p = Project(voices=[Voice("a", "A", effects=[{"type": "gain", "db": 5}]), Voice("b", "B", effects=[{"type": "gain", "db": 3}, {"type": "eq", "bands": []}])],
                master_effects=[{"type": "gain", "db": 7.8}])
    assert server.fader_basis_db(p) == pytest.approx(11.8)


def test_auto_export_failure_becomes_finding(tmp_path):
    """書き出しに失敗しても例外にせず、要確認の項目にする（素材がない場合）"""
    prog = _transcript_fixture(tmp_path)
    got = server.auto_export(prog / "20261204" / "20261204.podproj", lambda f, s: None)
    assert [f["kind"] for f in got] == ["export"]
    assert not (prog / "20261204" / "20261204.mp3").exists()


def test_learn_from_old_weak_match_without_fields(tmp_path, monkeypatch):
    """name / source のない古い review.json の弱い一致でも、文とプロジェクトから声紋を強める"""
    d, ed = _review_env(tmp_path, [])
    Project(sample_rate=FS, sources={"voice2": Source("素材/261218_2.wav")}, voices=[Voice("voice2", "青木さん")]).save(ed / "20261204.podproj")
    old = {"kind": "weak_match", "message": "青木さん（261218_2.wav） は 青木さん と判定しましたが点数が低めです（0.92）。別の人でないか確認してください", "time": None}
    assert library._weak_match_target(d, "20261204", old) == ("青木さん", "voice2")
    got = []
    monkeypatch.setattr(library, "_track_embedding_for", lambda b, e, s, **k: (got.append(s), (np.array([0, 1, 0, 0], dtype=np.float32), 30.0))[1])
    assert library.learn_from_review(d, "20261204", old) == "青木さんの声紋に 12/4 の声を足しました（2 回分）"
    assert got == ["voice2"]
    # 埋め込みに失敗したら、そのことを伝える
    monkeypatch.setattr(library, "_track_embedding_for", lambda *a, **k: (_ for _ in ()).throw(OSError("音がない")))
    assert "強められませんでした" in library.learn_from_review(d, "20261204", old)


def _clap_project(tmp_path, claps, dur=40.0):
    """2人分の声トラック（小さな雑音）に、claps（秒）の位置で同時に手をたたいた音を入れる。"""
    rng = np.random.default_rng(0)
    n = int(dur * FS)
    paths = {}
    for i, sid in enumerate(("v1", "v2")):
        x = (0.001 * rng.standard_normal(n)).astype(np.float32)
        for c in claps:
            a = int(c * FS)
            burst = rng.standard_normal(int(0.03 * FS)) * np.exp(-np.arange(int(0.03 * FS)) / (0.004 * FS))
            x[a:a + len(burst)] += (0.6 * burst).astype(np.float32)
        f = tmp_path / f"{sid}.wav"
        sf.write(str(f), x, FS, subtype="FLOAT")
        paths[sid] = f.name
    p = Project(sample_rate=FS, sources={s: Source(f) for s, f in paths.items()},
                voices=[Voice("v1", "青木さん"), Voice("v2", "内田さん")], edit=Edit(segments=[Segment(1.0, dur)]))
    p.sync.reference = "v1"
    return p


def test_end_clap_single_and_double_are_edit_points(tmp_path):
    p = _clap_project(tmp_path, [5.0, 30.0])
    assert abs(library.find_end_clap(p, tmp_path) - 5.0) < 0.02  # いちばん早いもの
    p = _clap_project(tmp_path, [30.0, 30.35])  # パンパン（2回）も編集点
    assert abs(library.find_end_clap(p, tmp_path) - 30.0) < 0.02
    assert library.trim_at_end_clap(p, tmp_path)[1] == pytest.approx(30.0 - library.END_CLAP_BEFORE_SEC, abs=0.02)
    assert p.edit.segments[-1].end == pytest.approx(29.7, abs=0.02)


def test_end_clap_ignores_applause_and_claps_in_speech(tmp_path):
    p = _clap_project(tmp_path, [30.0, 30.4, 30.8, 31.2, 31.6])  # 拍手喝采
    assert library.find_end_clap(p, tmp_path) is None
    p = _clap_project(tmp_path, [30.0])
    tr = Transcript("m", "ja", [Utterance("v1", "v1", 28.0, 33.0, "話の途中", "話の途中")])
    assert library.find_end_clap(p, tmp_path, tr) is None
    assert library.find_end_clap(_clap_project(tmp_path, []), tmp_path) is None


def test_server_remembers_open_episode_across_restart(tmp_path):
    """サーバーを起動し直しても、前に開いていた回を開いたままにする（画面の保存・書き出しが続けられる）"""
    _transcript_fixture(tmp_path)
    c = TestClient(create_app(library_root=tmp_path))
    assert c.get("/api/current").json() is None
    assert c.post("/api/open", json={"program": "番組", "episode": "20261204"}).status_code == 200
    c2 = TestClient(create_app(library_root=tmp_path))  # 起動し直し
    assert c2.get("/api/current").json() == {"program": "番組", "episode": "20261204"}
    assert c2.get("/api/project").status_code == 200
    (tmp_path / ".podcast-editor-current.json").write_text('{"program": "../x", "episode": "1"}', encoding="utf-8")
    assert TestClient(create_app(library_root=tmp_path)).get("/api/current").json() is None
