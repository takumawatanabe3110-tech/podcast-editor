"""dynamics_reference.json を作る。実行：
/Users/tesutokoushi/Developer/podcast-editor/.venv/bin/python ui/src/__fixtures__/make_reference.py
値は整数で保存（入力は ×1e7、出力は ×1e6）してサイズを抑える。"""
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "engine"))
from scipy.signal import sosfreqz  # noqa: E402

from podcast_engine import effects  # noqa: E402

FS = 24000
rng = np.random.default_rng(0)
t = np.arange(int(0.2 * FS)) / FS
x = np.concatenate([
    rng.standard_normal(int(0.1 * FS)) * 1e-4,
    0.5 * np.sin(2 * np.pi * 1000 * t),
    0.02 * np.sin(2 * np.pi * 1000 * t),
])
x = np.round(x, 7)
x32 = x.astype(np.float32)[None, :]

COMP = dict(type="compressor", threshold_db=-20, ratio=4, knee=50, attack_ms=5, release_ms=50, makeup_db=3, dry_mix=0)
GATE = dict(type="gate", threshold_db=-30, range_db=20, attack_ms=1, hold_ms=20, release_ms=50)


def run(params):
    return effects._FACTORIES[params["type"]](params, FS)(x32)[0]


def ints(a, scale):
    return [int(v) for v in np.round(np.asarray(a, dtype=np.float64) * scale)]


out = {
    "fs": FS,
    "block": max(1, int(FS * 0.00025)),
    "inputScale": 1e7,
    "outputScale": 1e6,
    "input": ints(x, 1e7),
    "compressor": {"params": {k: v for k, v in COMP.items() if k != "type"}, "output": ints(run(COMP), 1e6)},
}
if "gate" in effects._FACTORIES:
    out["gate"] = {"params": {k: v for k, v in GATE.items() if k != "type"}, "output": ints(run(GATE), 1e6)}
else:
    print("gate はまだ effects._FACTORIES にありません。省略しました")

freqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
bands = [
    {"type": "highpass", "freq": 104},
    {"type": "lowshelf", "freq": 176, "gain_db": 3},
    {"type": "bell", "freq": 3000, "gain_db": 3, "q": 1},
    {"type": "highshelf", "freq": 5000, "gain_db": -4},
    {"type": "bell", "freq": 500, "gain_db": -6, "q": 2},
    {"type": "lowpass", "freq": 8000},
]
eq = []
for b in bands:
    _, h = sosfreqz(effects.eq_sos([b], FS), worN=freqs, fs=FS)
    eq.append({"band": b, "freqs": freqs, "db": [round(float(v), 6) for v in 20 * np.log10(np.abs(h))]})
out["eq"] = eq

path = HERE / "dynamics_reference.json"
path.write_text(json.dumps(out, separators=(",", ":")))
print(path, path.stat().st_size, "bytes")
