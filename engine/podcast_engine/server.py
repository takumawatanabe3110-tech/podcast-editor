"""編集画面のためのサーバー（FastAPI）。Mac の中だけで動く（127.0.0.1）。

画面（ui/）に渡すもの
- GET  /api/project          プロジェクト（.podproj）と、計算済みの値（区間の出力位置、BGM の開始位置、素材の長さ）
- PUT  /api/project          プロジェクトを保存（画面での編集）
- GET  /api/transcript       文字起こし（.transcript.json）。なければ 404
- GET  /api/peaks/{素材ID}   波形の形（ファイル内の時刻で 1/PEAK_RATE 秒ごとの最小・最大）
- GET  /api/audio/{素材ID}   試聴用の音（24kHz・16bit WAV。声はノイズ除去済み）
- POST /api/export           書き出しを裏で始める（.mp3 / .wav）。同時には1つだけ
- GET  /api/export           書き出しの状況（idle / running / done / error）
重い処理（ノイズ除去・波形・試聴用の音）は .podcache/ に保存して使い回す。
再生・音量・カットはブラウザの中で、その場で行う。
"""

from __future__ import annotations

import hashlib
import dataclasses
import json
import math
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from . import audio_io
from .project import CACHE_DIR, Project

PREVIEW_FS = 24000  # 試聴用の音のサンプリングレート（ブラウザのメモリを抑える）
PEAK_RATE = 50  # 波形の細かさ（1秒あたりの点の数）
UI_DIST = Path(__file__).resolve().parents[2] / "ui" / "dist"


def export(project: Project, base_dir: str | Path, out_path: str | Path):
    """書き出す（レンダリング→ファイル→MP3 は測り直し）。RenderReport を返す。cmd_render と共用。"""
    from .render import render, write

    audio, rep = render(project, Path(base_dir))
    measured = write(
        out_path, audio, rep.sample_rate, project.output.mp3_kbps,
        project.output.loudness_lufs, project.output.true_peak_dbtp,
    )
    if measured is not None:  # MP3 は書いた後に測り直した値を使う
        rep.loudness_lufs, rep.true_peak_dbtp = measured
    return rep


def _num(x):
    """JSON に入れられない inf / nan を null にする。"""
    return None if isinstance(x, float) and not math.isfinite(x) else x


def _key(path: Path, extra: str = "") -> str:
    st = path.stat()
    return hashlib.sha256(f"{path.resolve()}|{st.st_size}|{st.st_mtime}|{extra}".encode()).hexdigest()[:16]


class Workspace:
    """1つのプロジェクトを開いている状態。"""

    def __init__(self, project_path: str | Path):
        self.path = Path(project_path).resolve()
        self.base = self.path.parent
        self.cache = self.base / CACHE_DIR
        self._export_lock = threading.Lock()
        self._export: dict = {"state": "idle"}  # 書き出しの状況（ロックして読み書きする）

    def load(self) -> Project:
        return Project.load(self.path)

    def transcript_path(self) -> Path:
        return self.path.with_suffix(".transcript.json")

    def playback_source(self, p: Project, sid: str) -> Path:
        """画面で鳴らす素材。声でノイズ除去が付いていれば、除去済み（キャッシュ）を使う。"""
        src = p.source_path(sid, self.base)
        voice = next((v for v in p.voices if v.source == sid), None)
        if voice is not None and voice.denoise:
            from .denoise import denoised_path

            return denoised_path(src, voice.denoise, self.cache)
        return src

    # ---- 書き出し（裏のスレッド）

    def default_export_path(self) -> Path:
        return self.path.with_suffix(".mp3")

    def start_export(self, out: Path) -> bool:
        """書き出しを始める。すでに実行中なら False。"""
        with self._export_lock:
            if self._export["state"] == "running":
                return False
            started = time.time()
            self._export = {"state": "running", "path": str(out), "started": started}
        threading.Thread(target=self._run_export, args=(out, started), daemon=True).start()
        return True

    def _run_export(self, out: Path, started: float) -> None:
        try:
            rep = export(self.load(), self.base, out)  # 開始時にディスクから読む
            res = {
                "state": "done", "path": str(out), "elapsed": time.time() - started,
                "report": {k: _num(v) for k, v in dataclasses.asdict(rep).items()},
            }
        except Exception as e:  # 失敗は状況に入れて画面に見せる
            res = {"state": "error", "path": str(out), "message": f"書き出しに失敗しました：{type(e).__name__}: {e}"}
        with self._export_lock:
            self._export = res

    def export_status(self) -> dict:
        with self._export_lock:
            st = dict(self._export)
        if st["state"] == "running":
            st["elapsed"] = time.time() - st["started"]
        return st

    # ---- 計算済みの値

    def derived(self, p: Project) -> dict:
        sources = {}
        for sid in p.sources:
            path = p.source_path(sid, self.base)
            if path.exists():
                if path.suffix.lower() in (".wav", ".flac", ".aif", ".aiff"):
                    inf = audio_io.info(path)
                    sources[sid] = {"duration": inf.duration, "sample_rate": inf.sample_rate}
                else:
                    from pedalboard.io import AudioFile

                    with AudioFile(str(path)) as f:
                        sources[sid] = {"duration": f.frames / f.samplerate, "sample_rate": int(f.samplerate)}
        return {
            "output_end": p.edit.output_end,
            "layout": [{"out_start": t, "start": s.start, "end": s.end} for t, s in p.edit.layout()],
            "bgm": [{"source": b.source, "start": p.bgm_start(b), "duration": b.duration} for b in p.bgm],
            "sources": sources,
        }

    # ---- 波形

    def peaks(self, p: Project, sid: str) -> dict:
        path = self.playback_source(p, sid)
        out = self.cache / f"{path.stem}.peaks-{_key(path, str(PEAK_RATE))}.json"
        if out.exists():
            return json.loads(out.read_text(encoding="utf-8"))
        x, fs = _read_mono(path)
        hop = max(1, fs // PEAK_RATE)
        n = len(x) // hop
        seg = x[: n * hop].reshape(n, hop)
        lo, hi = seg.min(axis=1), seg.max(axis=1)
        scale = float(max(np.abs(lo).max(initial=0), np.abs(hi).max(initial=0))) or 1.0
        data = {
            "rate": fs / hop, "scale": scale,
            "min": np.round(lo / scale * 127).astype(int).tolist(),
            "max": np.round(hi / scale * 127).astype(int).tolist(),
        }
        self.cache.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(data), encoding="utf-8")
        return data

    # ---- 試聴用の音

    def preview_audio(self, p: Project, sid: str) -> Path:
        path = self.playback_source(p, sid)
        out = self.cache / f"{path.stem}.preview-{_key(path, str(PREVIEW_FS))}.wav"
        if out.exists():
            return out
        if path.suffix.lower() in (".wav", ".flac", ".aif", ".aiff"):
            x, fs = audio_io.read(path, dtype="float32")
        else:
            from pedalboard.io import AudioFile

            with AudioFile(str(path)) as f:
                x, fs = f.read(f.frames).T, int(f.samplerate)
        y = audio_io.resample(x, fs, PREVIEW_FS)
        self.cache.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.stem + ".tmp.wav")
        sf.write(str(tmp), np.clip(y, -1, 1), PREVIEW_FS, subtype="PCM_16")
        tmp.replace(out)
        return out


def _read_mono(path: Path):
    if path.suffix.lower() in (".wav", ".flac", ".aif", ".aiff"):
        return audio_io.read(path, mono=True, dtype="float32")
    from pedalboard.io import AudioFile

    with AudioFile(str(path)) as f:
        return f.read(f.frames).mean(axis=0), int(f.samplerate)


def create_app(project_path: str | Path):
    from fastapi import Body, FastAPI, HTTPException
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    ws = Workspace(project_path)
    app = FastAPI(title="podcast-editor")

    def project_or_404(sid: Optional[str] = None) -> Project:
        p = ws.load()
        if sid is not None and sid not in p.sources:
            raise HTTPException(404, f"素材 {sid!r} はありません")
        return p

    @app.get("/api/project")
    def get_project():
        p = ws.load()
        return {"name": ws.path.name, "project": p.to_dict(), "derived": ws.derived(p)}

    @app.put("/api/project")
    def put_project(data: dict = Body(...)):
        try:
            p = Project.from_dict(data)
        except (TypeError, ValueError) as e:
            raise HTTPException(400, f"プロジェクトとして読めません：{e}")
        errs = p.validate()
        if errs:
            raise HTTPException(400, "\n".join(errs))
        p.save(ws.path)
        return {"name": ws.path.name, "project": p.to_dict(), "derived": ws.derived(p)}

    @app.get("/api/transcript")
    def get_transcript():
        t = ws.transcript_path()
        if not t.exists():
            raise HTTPException(404, "文字起こしがまだありません（transcribe コマンドで作れます）")
        return json.loads(t.read_text(encoding="utf-8"))

    @app.put("/api/transcript")
    def put_transcript(data: dict = Body(...)):
        """台本の文字の修正を保存する（音声は変わらない）。"""
        from .transcribe import Transcript

        try:
            tr = Transcript.from_dict(data)
        except (TypeError, ValueError, KeyError) as e:
            raise HTTPException(400, f"文字起こしとして読めません：{e}")
        tr.save(ws.transcript_path())
        ws.path.with_suffix(".transcript.txt").write_text(tr.script_text(), encoding="utf-8")
        return tr.to_dict()

    @app.get("/api/peaks/{sid}")
    def get_peaks(sid: str):
        return ws.peaks(project_or_404(sid), sid)

    @app.get("/api/audio/{sid}")
    def get_audio(sid: str):
        return FileResponse(ws.preview_audio(project_or_404(sid), sid), media_type="audio/wav")

    @app.post("/api/export")
    def post_export(data: Optional[dict] = Body(None)):
        raw = (data or {}).get("path")
        if raw is not None and not isinstance(raw, str):
            raise HTTPException(400, "path は文字列で指定してください")
        out = Path(raw).expanduser() if raw else ws.default_export_path()
        if not out.is_absolute():
            out = ws.base / out  # 相対パスは .podproj のフォルダから
        if out.suffix.lower() not in (".mp3", ".wav"):
            raise HTTPException(400, "書き出せるのは .mp3 か .wav です")
        if not out.parent.is_dir():
            raise HTTPException(400, f"保存先のフォルダがありません：{out.parent}")
        if not ws.start_export(out):
            raise HTTPException(409, "いま書き出し中です。終わるまでお待ちください")
        return {"state": "running", "path": str(out)}

    @app.get("/api/export")
    def get_export():
        return ws.export_status()

    @app.middleware("http")
    async def no_stale_page(request, call_next):
        # 画面の入口（index.html）と API は毎回確かめさせる。古い画面のまま開くのを防ぐ。
        # assets/ のファイルは名前に中身の印が入るので、覚えさせてよい
        res = await call_next(request)
        if not request.url.path.startswith("/assets/"):
            res.headers["Cache-Control"] = "no-cache"
        return res

    if UI_DIST.exists():
        app.mount("/", StaticFiles(directory=str(UI_DIST), html=True), name="ui")
    return app
