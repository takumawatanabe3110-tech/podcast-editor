"""編集画面のためのサーバー（FastAPI）。Mac の中だけで動く（127.0.0.1）。

画面（ui/）に渡すもの
- GET  /api/project          プロジェクト（.podproj）と、計算済みの値（区間の出力位置、BGM の開始位置、素材の長さ）
- PUT  /api/project          プロジェクトを保存（画面での編集）
- GET  /api/transcript       文字起こし（.transcript.json）。なければ 404
- GET  /api/peaks/{素材ID}   波形の形（ファイル内の時刻で 1/PEAK_RATE 秒ごとの最小・最大）
- GET  /api/audio/{素材ID}   試聴用の音（24kHz・16bit WAV。声はノイズ除去済み。?raw=1 なら元のまま）
- POST /api/export           書き出しを裏で始める（.mp3 / .wav）。同時には1つだけ
- GET  /api/export           書き出しの状況（idle / running / done / error）
- GET  /api/library          番組の一覧（各番組のエピソード・メンバー・BGM つき）
- GET/PUT /api/programs/{番組}, POST /api/programs   番組の設定（program.json）・新しい番組
- POST /api/programs/{番組}/bgm                     BGM をアップロード（role = op / ed など）
- POST/DELETE /api/programs/{番組}/members/{名前}[/voiceprint]   声紋の登録・メンバーの削除
- POST /api/programs/{番組}/episodes                新しいエピソード（日付と素材）を順番待ちに入れる。裏では1つずつ（先に入れた順）
- GET  /api/programs/{番組}/episodes/{日付}/status   その状況（queued / running / done / error / idle、要確認つき）
- DELETE /api/programs/{番組}/episodes/{日付}/job    順番待ちの取り消し（実行中は不可。素材は残す）
- GET  /api/programs/{番組}/episodes/{日付}/transcript   書き出した音声の時刻に合わせた文字起こし（一覧で聴きながら読む用）
- GET  /api/jobs                                    実行中と順番待ちの一覧
- POST/PUT /api/programs/{番組}/episodes/{日付}/review   要確認の作り直し／解決済みにする
- POST /api/open {program, episode}, GET /api/current   開くエピソードの切り替え
  以下の /api/project などは、いま開いているエピソードに対して働く
- GET  /api/presets, GET /api/presets/{名前}   プリセットの一覧・中身
- PUT  /api/presets/{名前}/bgm/{素材ID}        いまの BGM をプリセットに保存
- PUT  /api/presets/{名前}/effects/{track}     エフェクトをプリセットに保存（voice:0 / bgm / master）
重い処理（ノイズ除去・波形・試聴用の音）は .podcache/ に保存して使い回す。
再生・音量・カットはブラウザの中で、その場で行う。
"""

from __future__ import annotations

import hashlib
import dataclasses
import json
import math
import shutil
import threading
import time
from pathlib import Path
from typing import List, Optional

import numpy as np
import soundfile as sf

from . import audio_io, effects, library, presets
from .project import CACHE_DIR, Project

try:  # アップロードの型が実行時に要るので、ここで読む（なくても export など他の機能は使える）
    from fastapi import Body, File, Form, HTTPException, UploadFile
except ImportError:  # pragma: no cover
    pass

PREVIEW_FS = 24000  # 試聴用の音のサンプリングレート（ブラウザのメモリを抑える）
PEAK_RATE = 50  # 波形の細かさ（1秒あたりの点の数）
UI_DIST = Path(__file__).resolve().parents[2] / "ui" / "dist"
DEFAULT_LIBRARY = Path(__file__).resolve().parents[2]  # 番組フォルダが並ぶ場所（既定はリポジトリのルート）
AUDIO_EXTS = (".wav", ".flac", ".aif", ".aiff")


def export(project: Project, base_dir: str | Path, out_path: str | Path, progress=None):
    """書き出す（レンダリング→ファイル→MP3 は測り直し）。RenderReport を返す。cmd_render と共用。
    progress(0〜1, 説明) を渡すと進み具合を伝える（後戻りしない）。"""
    from .render import RENDER_WEIGHT, render, scaled, write

    audio, rep = render(project, Path(base_dir), scaled(progress, 0.0, RENDER_WEIGHT))
    measured = write(
        out_path, audio, rep.sample_rate, project.output.mp3_kbps,
        project.output.loudness_lufs, project.output.true_peak_dbtp,
        progress=scaled(progress, RENDER_WEIGHT, 1.0),
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

    def playback_source(self, p: Project, sid: str, raw: bool = False) -> Path:
        """画面で鳴らす素材。声でノイズ除去が付いていれば、除去済み（キャッシュ）を使う。raw なら元のまま。"""
        src = p.source_path(sid, self.base)
        if raw:
            return src
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
            self._export = {"state": "running", "path": str(out), "started": started,
                            "progress": 0.0, "stage": "準備しています"}
        threading.Thread(target=self._run_export, args=(out, started), daemon=True).start()
        return True

    def _run_export(self, out: Path, started: float) -> None:
        try:
            def on_progress(frac: float, stage: str) -> None:
                with self._export_lock:
                    if self._export.get("state") == "running":
                        self._export["progress"] = max(self._export.get("progress", 0.0), frac)
                        self._export["stage"] = stage

            rep = export(self.load(), self.base, out, on_progress)  # 開始時にディスクから読む
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
            p = st.get("progress", 0.0)  # 残り時間は経過時間から見積もる（5% 以上進んでから）
            st["remaining"] = st["elapsed"] * (1 - p) / p if p >= 0.05 else None
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

    def peaks(self, p: Project, sid: str, raw: bool = False) -> dict:
        path = self.playback_source(p, sid, raw)
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

    def preview_audio(self, p: Project, sid: str, raw: bool = False) -> Path:
        path = self.playback_source(p, sid, raw)
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


def build_episode(program_dir: Path, date: str, files: List[Path], progress, log=lambda s: None,
                  names: Optional[List[str]] = None, title: Optional[str] = None) -> Path:
    """新しいエピソードを作る一連の処理（同期・初期設定・ノイズ除去・話者判定・文字起こし・波形の準備）。
    progress(0〜1, 説明)。.podproj のパスを返す。要確認は review.json に保存する。
    names（files と同じ順）を渡すと、声紋での名前付けはせずその名前を使う。"""
    prog = library.load_program(program_dir)
    ep_dir = program_dir / date
    proj_path = ep_dir / f"{date}.podproj"
    prints = None if names else (library.program_prints(prog, program_dir) or None)
    res = library.create_episode(
        [str(f) for f in files], proj_path, preset=prog.get("preset") or None,
        name=title or f"{prog.get('name', program_dir.name)} {library._date_text(date)}",
        names=names, bgm_paths=library.program_bgm_paths(prog, program_dir),
        prints=prints, precompute_denoise=True, progress=progress, log=log,
    )
    findings = library.sync_findings(res["sync"])
    if res.get("embs") and prints:
        findings += library.voiceprint_findings(res["project"], res["embs"], prints)
    library.save_review(ep_dir, findings)
    n_voice = len(files)
    done = [0]

    def on_log(msg: str) -> None:  # 文字起こしは1トラックずつ。始まるたびに進める
        log(msg)
        progress(0.6 + 0.3 * done[0] / max(1, n_voice), msg)
        done[0] += 1

    progress(0.6, "文字起こしをしています（時間がかかります）")
    library.transcribe_and_save(proj_path, log=on_log)
    from .transcribe import Transcript

    tr = Transcript.load(proj_path.with_suffix(".transcript.json"))
    library.save_review(ep_dir, findings + library.transcript_findings(tr, Project.load(proj_path)))

    ws = Workspace(proj_path)  # 画面で最初に開くときに待たないよう、波形と試聴用の音を作っておく
    p = ws.load()
    targets = [(sid, False) for sid in p.sources] + [(v.source, True) for v in p.voices if v.denoise]
    for i, (sid, raw) in enumerate(targets):
        progress(0.9 + 0.1 * i / len(targets), "波形と試聴用の音を準備しています")
        ws.peaks(p, sid, raw)
        ws.preview_audio(p, sid, raw)
    progress(1.0, "できました")
    return proj_path


def guess_library(project_path: Path) -> Optional[Path]:
    """<root>/<番組>/<日付>/x.podproj の形なら root を返す（番組フォルダに program.json があるとき）。"""
    d = project_path.resolve().parent
    if library.DATE_RE.match(d.name) and (d.parent / library.PROGRAM_FILE).is_file():
        return d.parent.parent
    return None


def create_app(project_path: str | Path | None = None, library_root: str | Path | None = None):
    from fastapi import FastAPI
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    root = Path(library_root) if library_root else None
    if root is None and project_path:
        root = guess_library(Path(project_path))
    root = (root or DEFAULT_LIBRARY).resolve()

    cur: dict = {"ws": None, "program": None, "episode": None}  # いま開いているエピソード
    app = FastAPI(title="podcast-editor")

    def W() -> Workspace:
        if cur["ws"] is None:
            raise HTTPException(404, "エピソードを開いていません（POST /api/open で開きます）")
        return cur["ws"]

    def open_ws(path: Path) -> None:
        cur["ws"] = Workspace(path)
        d = cur["ws"].base
        if library.DATE_RE.match(d.name) and (d.parent / library.PROGRAM_FILE).is_file() and d.parent.parent == root:
            cur["program"], cur["episode"] = d.parent.name, d.name
        else:
            cur["program"] = cur["episode"] = None

    if project_path:
        open_ws(Path(project_path))

    def project_or_404(sid: Optional[str] = None) -> Project:
        p = W().load()
        if sid is not None and sid not in p.sources:
            raise HTTPException(404, f"素材 {sid!r} はありません")
        return p

    @app.get("/api/project")
    def get_project():
        p = W().load()
        return {"name": W().path.name, "project": p.to_dict(), "derived": W().derived(p)}

    @app.put("/api/project")
    def put_project(data: dict = Body(...)):
        try:
            p = Project.from_dict(data)
        except (TypeError, ValueError) as e:
            raise HTTPException(400, f"プロジェクトとして読めません：{e}")
        errs = p.validate()
        if errs:
            raise HTTPException(400, "\n".join(errs))
        p.save(W().path)
        return {"name": W().path.name, "project": p.to_dict(), "derived": W().derived(p)}

    @app.get("/api/transcript")
    def get_transcript():
        t = W().transcript_path()
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
        tr.save(W().transcript_path())
        W().path.with_suffix(".transcript.txt").write_text(tr.script_text(), encoding="utf-8")
        return tr.to_dict()

    @app.get("/api/peaks/{sid}")
    def get_peaks(sid: str, raw: int = 0):
        return W().peaks(project_or_404(sid), sid, bool(raw))

    @app.get("/api/audio/{sid}")
    def get_audio(sid: str, raw: int = 0):
        return FileResponse(W().preview_audio(project_or_404(sid), sid, bool(raw)), media_type="audio/wav")

    @app.post("/api/export")
    def post_export(data: Optional[dict] = Body(None)):
        raw = (data or {}).get("path")
        if raw is not None and not isinstance(raw, str):
            raise HTTPException(400, "path は文字列で指定してください")
        out = Path(raw).expanduser() if raw else W().default_export_path()
        if not out.is_absolute():
            out = W().base / out  # 相対パスは .podproj のフォルダから
        if out.suffix.lower() not in (".mp3", ".wav"):
            raise HTTPException(400, "書き出せるのは .mp3 か .wav です")
        if not out.parent.is_dir():
            raise HTTPException(400, f"保存先のフォルダがありません：{out.parent}")
        if not W().start_export(out):
            raise HTTPException(409, "いま書き出し中です。終わるまでお待ちください")
        return {"state": "running", "path": str(out)}

    @app.get("/api/export")
    def get_export():
        return W().export_status()

    # ---- プリセット（読み書き）。置き場所は呼ぶたびに presets.PRESET_DIR から決める

    def preset_file(name: str) -> Path:
        if not name or "/" in name or "\\" in name or ".." in name:
            raise HTTPException(400, f"プリセット名 {name!r} は使えません")
        return presets.PRESET_DIR / f"{name}.json"

    def read_preset(name: str) -> dict:
        f = preset_file(name)
        if not f.exists():
            raise HTTPException(404, f"プリセット {name!r} がありません")
        return json.loads(f.read_text(encoding="utf-8"))

    def remember_preset(p: Project, name: str) -> None:
        if not p.preset:
            p.preset = name
            p.save(W().path)

    @app.get("/api/presets")
    def get_presets():
        return presets.list_presets(presets.PRESET_DIR)

    @app.get("/api/presets/{name}")
    def get_preset(name: str):
        return read_preset(name)

    @app.put("/api/presets/{name}/bgm/{sid}")
    def put_preset_bgm(name: str, sid: str):
        """いまのプロジェクトの BGM クリップを、プリセットの同じ名前の BGM に上書き（なければ追加）。"""
        preset = read_preset(name)
        p = W().load()
        clip = next((b for b in p.bgm if b.source == sid), None)
        if clip is None:
            raise HTTPException(404, f"BGM {sid!r} はありません")
        items = preset.setdefault("bgm", [])
        idx = next((i for i, b in enumerate(items) if b.get("source") == sid), None)
        entry = presets.clip_to_preset(p, clip, presets.PRESET_DIR, W().base, items[idx] if idx is not None else None)
        if idx is None:
            items.append(entry)
        else:
            items[idx] = entry
        presets.save_preset(preset_file(name), preset)
        remember_preset(p, name)
        return {"entry": entry, "preset": name}

    @app.put("/api/presets/{name}/effects/{track}")
    def put_preset_effects(name: str, track: str, data: dict = Body(...)):
        effects_list = data.get("effects")
        if not isinstance(effects_list, list):
            raise HTTPException(400, "effects は配列で指定してください")
        errs = effects.validate(effects_list, "effects")
        if errs:
            raise HTTPException(400, "\n".join(errs))
        preset = read_preset(name)
        try:
            presets.set_effects_for_track(preset, track, effects_list)
        except ValueError as e:
            raise HTTPException(400, str(e))
        presets.save_preset(preset_file(name), preset)
        remember_preset(W().load(), name)
        return {"preset": name, "track": track, "effects": effects_list}


    # ---- 番組・エピソードのライブラリ

    def pdir(prog: str) -> Path:
        try:
            library.check_name(prog, "番組")
        except ValueError as e:
            raise HTTPException(400, str(e))
        d = root / prog
        if not (d / library.PROGRAM_FILE).is_file():
            raise HTTPException(404, f"番組 {prog!r} がありません")
        return d

    def program_view(d: Path) -> dict:
        prog = library.load_program(d)
        return {
            "id": d.name, "name": prog.get("name", d.name), "preset": prog.get("preset"),
            "episodes": episodes_with_jobs(d), "members": library.member_summary(prog, d),
            "bgm": prog.get("bgm", {}),
        }

    def program_view_full(d: Path) -> dict:
        """program.json の中身（メンバーは enrolled つき）に id と episodes を足したもの。"""
        return {**library.load_program(d), **program_view(d)}

    @app.get("/api/library")
    def get_library():
        return {"root": str(root), "programs": [program_view(Path(x["path"])) for x in library.list_programs(root)]}

    @app.get("/api/programs/{prog}")
    def get_program(prog: str):
        return program_view_full(pdir(prog))

    @app.put("/api/programs/{prog}")
    def put_program(prog: str, data: dict = Body(...)):
        """番組の設定をまるごと保存（メンバーの追加・名前や役割の変更、BGM の差し替えなど）。"""
        d = pdir(prog)
        data = {k: v for k, v in data.items() if k not in ("id", "episodes")}
        if isinstance(data.get("members"), list):  # 画面用の enrolled は保存しない
            data["members"] = [{k: v for k, v in m.items() if k != "enrolled"} if isinstance(m, dict) else m
                               for m in data["members"]]
        try:
            library.validate_program(data, d)
        except ValueError as e:
            raise HTTPException(400, str(e))
        library.save_program(d, data)
        return program_view_full(d)

    @app.post("/api/programs")
    def post_program(data: dict = Body(...)):
        try:
            d = library.create_program(root, data.get("name"), data.get("preset"))
        except FileExistsError as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        return program_view(d)

    def safe_filename(upload) -> str:
        name = Path(upload.filename or "").name
        try:
            return library.check_name(name, "ファイル名")
        except ValueError as e:
            raise HTTPException(400, str(e))

    def save_upload(upload, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        with open(tmp, "wb") as f:
            shutil.copyfileobj(upload.file, f)
        tmp.replace(dest)

    @app.post("/api/programs/{prog}/bgm")
    def post_program_bgm(prog: str, role: str = Form(...), file: UploadFile = File(...)):
        d = pdir(prog)
        try:
            library.check_name(role, "役割")
        except ValueError as e:
            raise HTTPException(400, str(e))
        name = safe_filename(file)
        save_upload(file, d / library.BGM_DIR / name)
        data = library.load_program(d)
        data["bgm"][role] = f"{library.BGM_DIR}/{name}"
        library.save_program(d, data)
        return {"role": role, "path": data["bgm"][role]}

    @app.post("/api/programs/{prog}/members/{name}/voiceprint")
    def post_voiceprint(prog: str, name: str, data: dict = Body(...)):
        d = pdir(prog)
        try:
            return library.enroll_voiceprint(d, name, str(data.get("episode", "")), str(data.get("source", "")),
                                             data.get("role"))
        except ValueError as e:
            raise HTTPException(400, str(e))
        except (FileNotFoundError, KeyError) as e:
            raise HTTPException(404, str(e).strip("'\""))

    @app.delete("/api/programs/{prog}/members/{name}")
    def delete_member(prog: str, name: str):
        if not library.remove_member(pdir(prog), name):
            raise HTTPException(404, f"メンバー {name!r} はいません")
        return {"removed": name}

    # ---- エピソードを開く

    @app.post("/api/open")
    def post_open(data: dict = Body(...)):
        d = pdir(str(data.get("program", "")))
        eid = str(data.get("episode", ""))
        try:
            library.check_name(eid, "エピソード")
        except ValueError as e:
            raise HTTPException(400, str(e))
        proj = library.episode_project_path(d / eid)
        if proj is None:
            raise HTTPException(404, f"エピソード {eid!r} のプロジェクトがありません")
        open_ws(proj)
        cur["program"], cur["episode"] = d.name, eid
        return {"program": d.name, "episode": eid}

    @app.get("/api/current")
    def get_current():
        if cur["ws"] is None:
            return None
        return {"program": cur["program"], "episode": cur["episode"]}

    # ---- 新しいエピソード（順番待ち。裏のスレッドが先に入れた順に1つずつ）

    jobs: dict = {"cv": threading.Condition(), "queue": [], "running": None, "status": {}, "worker": None}

    def remaining_of(st: dict) -> Optional[float]:
        p = st.get("progress", 0.0)
        return (time.time() - st["started"]) * (1 - p) / p if p >= 0.05 else None  # 5% 進んでから見積もる

    def job_view(key) -> Optional[dict]:
        """順番待ち・実行中のときの様子（{state, position?, progress?, remaining?}）。なければ None。"""
        with jobs["cv"]:
            st = jobs["status"].get(key)
            if not st or st["state"] not in ("queued", "running"):
                return None
            if st["state"] == "queued":
                return {"state": "queued", "position": [j["key"] for j in jobs["queue"]].index(key) + 1}
            return {"state": "running", "progress": st.get("progress", 0.0), "remaining": remaining_of(st)}

    def episodes_with_jobs(d: Path) -> list:
        eps = library.list_episodes(d)
        for e in eps:
            j = job_view((d.name, e["id"]))
            if j:
                e["job"] = j
        return eps

    def run_job(job: dict) -> None:
        key = job["key"]

        def progress(frac: float, stage: str) -> None:
            with jobs["cv"]:
                st = jobs["status"][key]
                st["progress"] = max(st.get("progress", 0.0), frac)  # 後戻りしない
                st["stage"] = stage

        try:
            extra = {k: job[k] for k in ("names", "title") if job.get(k)}
            build_episode(job["dir"], job["date"], job["files"], progress, **extra)
            res = {"state": "done", "stage": "できました", "progress": 1.0, "message": ""}
        except Exception as e:
            res = {"state": "error", "message": f"エピソードの作成に失敗しました：{type(e).__name__}: {e}"}
        with jobs["cv"]:
            jobs["status"][key].update(res)
            jobs["running"] = None

    def worker() -> None:
        while True:
            with jobs["cv"]:
                while not jobs["queue"]:
                    jobs["cv"].wait()
                job = jobs["queue"].pop(0)
                jobs["running"] = job["key"]
                jobs["status"][job["key"]].update(state="running", stage="始めています", progress=0.0,
                                                  started=time.time())
            run_job(job)

    @app.post("/api/programs/{prog}/episodes")
    def post_episode(prog: str, date: str = Form(...), files: List[UploadFile] = File(...),
                     names: Optional[str] = Form(None), title: Optional[str] = Form(None)):
        d = pdir(prog)
        try:
            date = library.valid_date(date)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if len(files) < 2:
            raise HTTPException(400, "声の素材は2本以上必要です")
        fnames = [safe_filename(f) for f in files]
        if any(Path(n).suffix.lower() not in AUDIO_EXTS for n in fnames):
            raise HTTPException(400, "素材は .wav / .flac / .aif / .aiff で指定してください")
        if len(set(fnames)) != len(fnames):
            raise HTTPException(400, "同じ名前の素材があります")
        who = None  # 話者の名前（files と同じ順）。空なら無視
        if names and names.strip():
            try:
                who = json.loads(names)
            except ValueError:
                raise HTTPException(400, "names は JSON の配列で指定してください")
            if not isinstance(who, list) or not all(isinstance(x, str) for x in who):
                raise HTTPException(400, "names は文字列の配列で指定してください")
            if not any(x.strip() for x in who):
                who = None
            elif len(who) != len(files):
                raise HTTPException(400, "names の数が素材の数と違います")
        ep_dir = d / date
        if library.episode_project_path(ep_dir) is not None:
            raise HTTPException(409, f"{date} のエピソードはすでにあります")
        key = (d.name, date)
        with jobs["cv"]:
            if (jobs["status"].get(key) or {}).get("state") in ("queued", "running"):
                raise HTTPException(409, f"{date} のエピソードはすでに順番待ち（または作成中）です")
            jobs["status"][key] = {"state": "queued", "message": ""}  # 保存中に重ならないよう先に印を付ける
        order = sorted(range(len(files)), key=lambda i: fnames[i])  # 1本目（名前順）が同期の基準
        try:
            paths = []
            for i in order:
                dest = ep_dir / library.SOURCE_DIR / fnames[i]
                save_upload(files[i], dest)
                paths.append(dest)
        except Exception as e:
            with jobs["cv"]:
                jobs["status"][key] = {"state": "error", "message": f"素材を保存できませんでした：{e}"}
            raise HTTPException(500, f"素材を保存できませんでした：{e}")
        job = {"key": key, "dir": d, "date": date, "files": paths, "title": (title or "").strip() or None,
               "names": [(who[i].strip() or f"voice{n + 1}") for n, i in enumerate(order)] if who else None}
        with jobs["cv"]:
            jobs["queue"].append(job)
            position = len(jobs["queue"])  # 順番待ちの中での番号（1 から）
            if jobs["worker"] is None:
                jobs["worker"] = threading.Thread(target=worker, daemon=True)
                jobs["worker"].start()
            jobs["cv"].notify()
        return {"state": "queued", "program": d.name, "episode": date, "position": position}

    @app.get("/api/jobs")
    def get_jobs():
        with jobs["cv"]:
            running = None
            if jobs["running"]:
                st = jobs["status"][jobs["running"]]
                running = {"program": jobs["running"][0], "episode": jobs["running"][1],
                           "stage": st.get("stage", ""), "progress": st.get("progress", 0.0),
                           "remaining": remaining_of(st)}
            queued = [{"program": j["key"][0], "episode": j["key"][1], "position": i + 1}
                      for i, j in enumerate(jobs["queue"])]
        return {"running": running, "queued": queued}

    @app.delete("/api/programs/{prog}/episodes/{eid}/job")
    def delete_job(prog: str, eid: str):
        key = (pdir(prog).name, eid)
        with jobs["cv"]:
            st = jobs["status"].get(key) or {}
            if st.get("state") == "running":
                raise HTTPException(409, "作成中のものは取り消せません")
            hit = [j for j in jobs["queue"] if j["key"] == key]
            if not hit:
                raise HTTPException(404, f"{eid} は順番待ちにありません")
            jobs["queue"].remove(hit[0])
            jobs["status"].pop(key, None)
        return {"cancelled": eid}

    @app.get("/api/programs/{prog}/episodes/{eid}/status")
    def get_episode_status(prog: str, eid: str):
        d = pdir(prog)
        with jobs["cv"]:
            st = dict(jobs["status"].get((d.name, eid)) or {})
        review = library.load_review(d / eid) if library.DATE_RE.match(eid) else []
        if not st:
            if not (d / eid).is_dir():
                raise HTTPException(404, f"エピソード {eid!r} がありません")
            done = library.episode_project_path(d / eid) is not None
            return {"state": "done" if done else "idle", "stage": "", "progress": 1.0 if done else 0.0,
                    "remaining": None, "message": "", "review": review}
        out = {"state": st["state"], "stage": st.get("stage", ""), "progress": st.get("progress", 0.0),
               "remaining": None, "message": st.get("message", ""), "review": review}
        if st["state"] == "running":
            out["remaining"] = remaining_of(st)
            out["elapsed"] = time.time() - st["started"]
        elif st["state"] == "queued":
            out["position"] = job_view((d.name, eid))["position"]
        return out

    @app.get("/api/programs/{prog}/episodes/{eid}/audio")
    def get_episode_export(prog: str, eid: str):
        """書き出した完成版（mp3、なければ wav）。一覧で聴く用"""
        d = pdir(prog)
        try:
            library.check_name(eid, "エピソード")
        except ValueError as e:
            raise HTTPException(400, str(e))
        for ext, mt in ((".mp3", "audio/mpeg"), (".wav", "audio/wav")):
            f = d / eid / f"{eid}{ext}"
            if f.is_file():
                return FileResponse(f, media_type=mt)
        raise HTTPException(404, f"{eid} はまだ書き出していません")

    @app.get("/api/programs/{prog}/episodes/{eid}/transcript")
    def get_episode_transcript(prog: str, eid: str):
        """書き出した音声（出力時刻）に合わせた文字起こし。一覧の画面用"""
        d = pdir(prog)
        try:
            library.check_name(eid, "エピソード")
        except ValueError as e:
            raise HTTPException(400, str(e))
        pp = library.episode_project_path(d / eid)
        if pp is None:
            raise HTTPException(404, f"エピソード {eid!r} のプロジェクトがありません")
        tp = pp.with_suffix(".transcript.json")
        if not tp.is_file():
            raise HTTPException(404, f"{eid} の文字起こしがまだありません")
        from .transcribe import Transcript
        try:
            proj = Project.load(pp)
            lines = library.episode_transcript_lines(proj, Transcript.load(tp))
        except (ValueError, KeyError, OSError) as e:
            raise HTTPException(400, f"文字起こしを読めません：{e}")
        return {"lines": lines, "duration": proj.edit.output_end if proj.edit.segments else None}

    # ---- 要確認

    def episode_dir(prog: str, eid: str) -> Path:
        d = pdir(prog)
        try:
            library.check_name(eid, "エピソード")
        except ValueError as e:
            raise HTTPException(400, str(e))
        if library.episode_project_path(d / eid) is None:
            raise HTTPException(404, f"エピソード {eid!r} のプロジェクトがありません")
        return d

    @app.post("/api/programs/{prog}/episodes/{eid}/review")
    def post_review(prog: str, eid: str):
        d = episode_dir(prog, eid)
        return library.review_episode(d, eid)

    @app.put("/api/programs/{prog}/episodes/{eid}/review")
    def put_review(prog: str, eid: str, data: dict = Body(...)):
        d = episode_dir(prog, eid)
        idx = data.get("resolved")
        findings = library.load_review(d / eid)
        if not isinstance(idx, list) or not all(isinstance(i, int) and not isinstance(i, bool)
                                                and 0 <= i < len(findings) for i in idx):
            raise HTTPException(400, "resolved は要確認の番号（0 から）の配列で指定してください")
        for i in idx:
            findings[i]["resolved"] = True
        library.save_review(d / eid, findings)
        return findings

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
