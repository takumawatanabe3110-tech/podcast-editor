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
        if st["state"] != "running":
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


def test_episode_job_conflict_409(job_env, monkeypatch):
    c, d, waves, _ = job_env
    gate = threading.Event()

    def slow(program_dir, date, files, progress, log=lambda s: None):
        progress(0.5, "途中")
        gate.wait(30)
        return program_dir / date / f"{date}.podproj"

    monkeypatch.setattr(server, "build_episode", slow)
    assert post_episode(c, waves, date="20261204").status_code == 200
    st = c.get("/api/programs/番組/episodes/20261204/status").json()
    assert st["state"] == "running" and st["stage"] == "途中" and st["progress"] == 0.5
    r = post_episode(c, waves, date="20261211")
    assert r.status_code == 409
    assert not (d / "20261211").exists()
    gate.set()
    assert wait_status(c, "番組", "20261204")["state"] == "done"
    assert post_episode(c, waves, date="20261211").status_code == 200  # 終われば次が始められる
    wait_status(c, "番組", "20261211")


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
