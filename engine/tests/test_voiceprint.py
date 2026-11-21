import numpy as np
import pytest

from podcast_engine import voiceprint as vp


def test_similarity_and_identify():
    a = np.array([1.0, 0.0])
    b = np.array([0.0, 1.0])
    assert vp.similarity(a, a) == pytest.approx(1.0)
    assert vp.similarity(a, b) == pytest.approx(0.0)
    members = {"青木": a, "内田": b}
    name, s = vp.identify(np.array([0.9, 0.1]), members, 0.8)
    assert name == "青木" and s > 0.9
    name, s = vp.identify(np.array([1.0, 1.0]), members, 0.8)  # どちらにも遠い
    assert name is None and s == pytest.approx(0.7071, abs=1e-3)
    assert vp.identify(a, {}, 0.5) == (None, 0.0)


def test_assign_one_to_one():
    members = {"青木": np.array([1.0, 0.0, 0.0]), "内田": np.array([0.0, 1.0, 0.0])}
    tracks = {
        "t1": np.array([0.0, 1.0, 0.1]),
        "t2": np.array([1.0, 0.1, 0.0]),
        "t3": np.array([0.0, 0.0, 1.0]),  # ゲスト
    }
    assert vp.assign(tracks, members, 0.8) == {"t1": "内田", "t2": "青木", "t3": None}
    # 同じメンバーに2トラックが近くても、使われるのは片方だけ
    two = {"x": np.array([1.0, 0.0, 0.0]), "y": np.array([1.0, 0.2, 0.0])}
    r = vp.assign(two, members, 0.8)
    assert r["x"] == "青木" and r["y"] is None


def test_save_load_roundtrip(tmp_path):
    e = np.random.default_rng(0).standard_normal(256).astype(np.float32)
    p = tmp_path / "sub" / "aoki.npz"
    vp.save_print(p, e, {"name": "青木", "source": "ep9/track1", "seconds": 90.0})
    e2, meta = vp.load_print(p)
    assert np.allclose(e, e2)
    assert meta["name"] == "青木" and meta["seconds"] == 90.0
    assert meta["model"] == vp.MODEL_NAME and "created" in meta


def test_loud_frames_picks_loudest():
    fs = 1000
    x = np.zeros(fs * 4, dtype=np.float32)
    x[fs * 2 : fs * 3] = 0.5  # 1〜2秒目が相当しない、2〜3秒目だけ大きい
    sel = vp._loud_frames(x, fs, 1.0)
    assert len(sel) == fs and np.all(sel == 0.5)


def test_embed_smoke():
    pytest.importorskip("resemblyzer")
    fs = 22050
    t = np.arange(fs * 3) / fs
    x = (0.3 * np.sin(2 * np.pi * 150 * t) * (1 + 0.5 * np.sin(2 * np.pi * 3 * t))).astype(np.float32)
    e = vp.embed(x, fs)
    assert e.shape == (256,)
    assert np.linalg.norm(e) == pytest.approx(1.0, abs=1e-4)
