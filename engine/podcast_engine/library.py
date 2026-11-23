"""番組（プログラム）とエピソードのライブラリ。

置き場所（ライブラリのルート）
    <root>/<番組>/program.json         番組の設定（プリセット名、BGM、メンバーと声紋）
    <root>/<番組>/BGM/                 BGM のファイル
    <root>/<番組>/声紋/<名前>.npz      メンバーの声紋
    <root>/<番組>/YYYYMMDD/            1回分：素材/ ・ YYYYMMDD.podproj ・ .transcript.json ・ .mp3 ・ .podcache/
program.json 内のパスは、番組のフォルダからの相対パス。
"""

from __future__ import annotations

import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import audio_io
from .project import CACHE_DIR, DEFAULT_DENOISE, Project, Segment, Source, Sync, TrackOffset, Voice

PROGRAM_FORMAT = "podprogram"
PROGRAM_FILE = "program.json"
BGM_DIR = "BGM"
PRINT_DIR = "声紋"
SOURCE_DIR = "素材"
ROLES = ("mc", "guest")
DATE_RE = re.compile(r"^\d{8}$")

Progress = Callable[[float, str], None]


# ---------------------------------------------------------------- 名前・パスの確認


def check_name(name: str, what: str = "名前") -> str:
    """フォルダ名・ファイル名に使える名前か確認する（区切り文字や .. は不可）。"""
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"{what}が空です")
    if name != name.strip() or "/" in name or "\\" in name or ".." in name or name.startswith(".") or "\0" in name:
        raise ValueError(f"{what} {name!r} は使えません")
    return name


def inside(base: Path, rel: str) -> Path:
    """base からの相対パス rel を解決する。base の外に出るなら ValueError。"""
    if not isinstance(rel, str) or not rel or Path(rel).is_absolute():
        raise ValueError(f"パス {rel!r} は番組フォルダからの相対パスで書いてください")
    p = (base / rel).resolve()
    b = base.resolve()
    if p != b and b not in p.parents:
        raise ValueError(f"パス {rel!r} は番組フォルダの外に出ています")
    return p


def validate_program(data: dict, program_dir: Path) -> dict:
    """program.json として正しいか確認して、そのまま返す。だめなら ValueError。"""
    if not isinstance(data, dict) or data.get("format") != PROGRAM_FORMAT:
        raise ValueError("番組の設定ではありません（format が違います）")
    if not isinstance(data.get("name"), str) or not data["name"].strip():
        raise ValueError("name（番組名）が必要です")
    if data.get("preset") is not None and not isinstance(data["preset"], str):
        raise ValueError("preset は文字列で書いてください")
    if data.get("deliver_dir") is not None and not isinstance(data["deliver_dir"], str):
        raise ValueError("deliver_dir（完成版のコピー先）は文字列で書いてください")
    bgm = data.get("bgm", {})
    if not isinstance(bgm, dict):
        raise ValueError("bgm は {役割: パス} で書いてください")
    for role, rel in bgm.items():
        if not isinstance(role, str) or not role:
            raise ValueError("bgm の役割名が空です")
        inside(program_dir, rel)
    members = data.get("members", [])
    if not isinstance(members, list):
        raise ValueError("members は配列で書いてください")
    seen = set()
    for m in members:
        if not isinstance(m, dict):
            raise ValueError("members の各項目はオブジェクトで書いてください")
        check_name(m.get("name"), "メンバー名")
        if m["name"] in seen:
            raise ValueError(f"メンバー名 {m['name']!r} が重なっています")
        seen.add(m["name"])
        if m.get("role", "mc") not in ROLES:
            raise ValueError(f"role は {' / '.join(ROLES)} のどちらかです")
        if m.get("voiceprint") is not None:
            inside(program_dir, m["voiceprint"])
    return data


# ---------------------------------------------------------------- 番組


def load_program(program_dir) -> dict:
    d = json.loads((Path(program_dir) / PROGRAM_FILE).read_text(encoding="utf-8"))
    d.setdefault("bgm", {})
    d.setdefault("members", [])
    return d


def save_program(program_dir, data: dict) -> None:
    """program.json を書く（一時ファイルに書いてから置き換える）。"""
    path = Path(program_dir) / PROGRAM_FILE
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def list_programs(root) -> List[dict]:
    """ルートの下の番組（program.json があるフォルダ）。[{id, name, preset, path}]、フォルダ名順。"""
    root = Path(root)
    out = []
    for d in sorted(root.iterdir()) if root.is_dir() else []:
        if d.is_dir() and not d.name.startswith(".") and (d / PROGRAM_FILE).is_file():
            try:
                prog = load_program(d)
            except ValueError:
                continue
            out.append({"id": d.name, "name": prog.get("name", d.name), "preset": prog.get("preset"), "path": str(d)})
    return out


def create_program(root, name: str, preset: Optional[str] = None) -> Path:
    """番組のフォルダと program.json を作る。すでにあれば FileExistsError。"""
    check_name(name, "番組名")
    d = Path(root) / name
    if d.exists():
        raise FileExistsError(f"番組 {name!r} はすでにあります")
    (d / BGM_DIR).mkdir(parents=True)
    (d / PRINT_DIR).mkdir()
    save_program(d, {"format": PROGRAM_FORMAT, "version": 1, "name": name, "preset": preset, "bgm": {}, "members": []})
    return d


def program_bgm_paths(program: dict, program_dir) -> Dict[str, Path]:
    """{役割: BGM ファイルの絶対パス}（ファイルがあるものだけ）。"""
    base = Path(program_dir)
    out = {}
    for role, rel in (program.get("bgm") or {}).items():
        p = inside(base, rel)
        if p.is_file():
            out[role] = p
    return out


def program_prints(program: dict, program_dir) -> Dict[str, "np.ndarray"]:  # noqa: F821
    """声紋のあるメンバー {名前: 埋め込み}。"""
    from . import voiceprint

    out = {}
    for m in program.get("members", []):
        rel = m.get("voiceprint")
        if rel:
            f = inside(Path(program_dir), rel)
            if f.is_file():
                out[m["name"]], _ = voiceprint.load_print(f)
    return out


def member_summary(program: dict, program_dir) -> List[dict]:
    """画面に見せるメンバー一覧（enrolled：声紋のファイルがあるか）。"""
    out = []
    for m in program.get("members", []):
        rel = m.get("voiceprint")
        ok = False
        if rel:
            try:
                ok = inside(Path(program_dir), rel).is_file()
            except ValueError:
                pass
        out.append({**m, "role": m.get("role", "mc"), "enrolled": ok})
    return out


# ---------------------------------------------------------------- エピソード


def episode_project_path(episode_dir) -> Optional[Path]:
    d = Path(episode_dir)
    p = d / f"{d.name}.podproj"
    if p.is_file():
        return p
    others = sorted(d.glob("*.podproj"))
    return others[0] if others else None


def episode_transcript_lines(proj: Project, tr, prefer_script: bool = False) -> List[dict]:
    """文字起こしを、書き出した音声の時刻（出力時刻）の発言リストにする。

    カットされた区間に丸ごと入る発言は捨て、一部だけ入るものは区間の内側に切り詰める。
    話者名はプロジェクトの声の名前（なければ文字起こしの話者名）。
    prefer_script なら、編集画面に出る台本（script）を使い、空の発言は捨てる。
    """
    names = {v.source: v.name for v in proj.voices if v.name}
    out: List[dict] = []
    for u in tr.utterances:
        pieces = []
        for out_start, seg in proj.edit.layout():
            a, b = max(u.start, seg.start), min(u.end, seg.end)
            if b > a:
                pieces.append((out_start + (a - seg.start), out_start + (b - seg.start)))
        shown = (u.script if prefer_script else u.text) or ""
        if not pieces or not shown.strip():
            continue
        out.append({"speaker": names.get(u.source) or u.speaker, "text": shown,
                    "start": min(p[0] for p in pieces), "end": max(p[1] for p in pieces)})
    out.sort(key=lambda x: x["start"])
    return out


def deliver_episode(program_dir, eid: str, mp3, proj: Project, duration: float, transcript_path=None) -> Optional[Path]:
    """番組に deliver_dir があれば、書き出した MP3 と .listen.json をそこへコピーする。

    deliver_dir がなければ何もせず None。MP3 を先に、json を後に置く（json があれば聴ける合図）。
    """
    from datetime import timezone
    from .transcribe import Transcript

    program_dir = Path(program_dir)
    prog = load_program(program_dir)
    raw = (prog.get("deliver_dir") or "").strip()
    if not raw:
        return None
    dest = Path(raw).expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    name = prog.get("name") or program_dir.name
    date = _date_text(eid)
    stem = f"{name}_{date}"
    tp = Path(transcript_path) if transcript_path else None
    lines = episode_transcript_lines(proj, Transcript.load(tp), prefer_script=True) if tp and tp.is_file() else []
    colors = ["#6AA7FF", "#F2A65A", "#7BD88F", "#E58AE0"]
    meta = {
        "format": "podlisten", "version": 1, "program": name, "episode": eid, "date": date,
        "members": [m["name"] for m in prog.get("members", [])],
        "speakers": {v.name: colors[i % len(colors)] for i, v in enumerate(proj.voices) if v.name},
        "duration": float(duration), "audio": f"{stem}.mp3",
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "lines": lines,
    }
    tmp = dest / f".{stem}.mp3.tmp"
    shutil.copyfile(mp3, tmp)
    os.replace(tmp, dest / f"{stem}.mp3")
    tmp = dest / f".{stem}.listen.json.tmp"
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, dest / f"{stem}.listen.json")
    return dest / f"{stem}.mp3"


def _date_text(eid: str) -> str:
    return f"{eid[:4]}-{eid[4:6]}-{eid[6:]}"


def list_episodes(program_dir) -> List[dict]:
    """日付フォルダ（YYYYMMDD）ごとの様子。新しい順。"""
    base = Path(program_dir)
    out = []
    for d in sorted(base.iterdir(), reverse=True) if base.is_dir() else []:
        if not (d.is_dir() and DATE_RE.match(d.name)):
            continue
        proj = episode_project_path(d)
        title, duration = None, None
        if proj is not None:
            try:
                p = Project.load(proj)
                title, duration = p.name, p.edit.output_end
            except Exception:  # 壊れていても一覧は出す
                pass
        review = load_review(d)
        exp = None
        for ext in (".mp3", ".wav"):
            f = d / f"{d.name}{ext}"
            if f.is_file():
                st = f.stat()
                exp = {"path": str(f), "size": st.st_size, "mtime": st.st_mtime}
                break
        out.append({
            "id": d.name, "title": title or d.name, "date": _date_text(d.name),
            "has_project": proj is not None,
            "has_transcript": proj is not None and proj.with_suffix(".transcript.json").is_file(),
            "exported": exp, "duration": duration,
            "review": review, "review_open": sum(1 for f in review if not f.get("resolved")),
        })
    return out


def valid_date(text: str) -> str:
    if not isinstance(text, str) or not DATE_RE.match(text):
        raise ValueError("日付は YYYYMMDD（8桁の数字）で指定してください")
    try:
        datetime.strptime(text, "%Y%m%d")
    except ValueError:
        raise ValueError(f"日付 {text!r} は存在しません")
    return text


# ---------------------------------------------------------------- 声紋の登録


def _track_embedding_for(program_dir, episode: str, source: str, max_seconds: float = 120):
    """エピソードの1トラックの声紋（埋め込み）と、使った秒数を返す。登録・声紋の補強で共通。"""
    from . import voiceprint
    from .transcribe import Transcript

    base = Path(program_dir)
    ep_dir = base / check_name(episode, "エピソード")
    proj_path = episode_project_path(ep_dir)
    if proj_path is None:
        raise FileNotFoundError(f"エピソード {episode} のプロジェクトがありません")
    p = Project.load(proj_path)
    if source not in p.sources:
        raise KeyError(f"素材 {source!r} はありません")
    path = _existing_denoised(p, source, ep_dir)

    segments = None
    tr_path = proj_path.with_suffix(".transcript.json")
    if tr_path.is_file():
        voice = next((v for v in p.voices if v.source == source), None)
        speaker = (voice.name or source) if voice else source
        off = p.sync.offset(source)
        to_file = lambda t: t + off.offset_sec + off.drift_ppm * 1e-6 * t
        us = [u for u in Transcript.load(tr_path).utterances if u.speaker == speaker and u.source == source]
        us.sort(key=lambda u: u.start - u.end)  # 長い順
        segs = [(to_file(u.start), to_file(u.end)) for u in us]
        if sum(b - a for a, b in segs) >= 10:
            segments = segs

    emb = voiceprint.track_embedding(path, segments=segments, max_seconds=max_seconds)
    if segments:
        seconds = min(max_seconds, sum(b - a for a, b in segments))
    else:
        seconds = min(max_seconds, audio_io.info(path).duration)
    return emb, float(seconds)


def enroll_voiceprint(
    program_dir, name: str, episode: str, source: str, role: Optional[str] = None,
    max_seconds: float = 120,
) -> dict:
    """エピソードの1トラックから声紋を作り、番組のメンバーに登録する。メンバー（dict）を返す。

    ノイズ除去済みのキャッシュがあればそれを使う。文字起こしがあり、そのトラックの話者の発言があれば、
    その区間（長い順）だけを使う。なければ音量の大きい部分。
    """
    from . import voiceprint

    base = Path(program_dir)
    check_name(name, "メンバー名")
    if role is not None and role not in ROLES:
        raise ValueError(f"role は {' / '.join(ROLES)} のどちらかです")
    emb, seconds = _track_embedding_for(base, episode, source, max_seconds)
    rel = f"{PRINT_DIR}/{name}.npz"
    voiceprint.save_print(base / rel, emb, {
        "name": name, "episode": episode, "source": source, "seconds": round(float(seconds), 1),
    })
    prog = load_program(base)
    member = next((m for m in prog["members"] if m["name"] == name), None)
    if member is None:
        member = {"name": name, "role": role or "mc"}
        prog["members"].append(member)
    elif role:
        member["role"] = role
    member["voiceprint"] = rel
    save_program(base, prog)
    return dict(member)


def remove_member(program_dir, name: str) -> bool:
    """メンバーと声紋ファイルを消す。いなければ False。"""
    base = Path(program_dir)
    prog = load_program(base)
    member = next((m for m in prog["members"] if m["name"] == name), None)
    if member is None:
        return False
    if member.get("voiceprint"):
        f = inside(base, member["voiceprint"])
        if f.is_file():
            f.unlink()
    prog["members"] = [m for m in prog["members"] if m is not member]
    save_program(base, prog)
    return True


def _existing_denoised(p: Project, sid: str, ep_dir: Path) -> Path:
    """ノイズ除去済みのキャッシュがあればそれ、なければ元の素材（ここでは除去を新しく走らせない）。"""
    src = p.source_path(sid, ep_dir)
    voice = next((v for v in p.voices if v.source == sid), None)
    if voice is not None and voice.denoise:
        from . import denoise

        cache = ep_dir / CACHE_DIR
        stem = f"{src.stem}.denoise-{denoise._cache_key(src, voice.denoise)}"
        for ext in (".flac", ".wav"):
            if (cache / (stem + ext)).exists():
                return cache / (stem + ext)
    return src


# ---------------------------------------------------------------- エピソードを作る（init の中身）


def init_project(files: Sequence, out, name: Optional[str] = None, names: Optional[Sequence[str]] = None,
                 no_denoise: bool = False, log: Callable[[str], None] = lambda s: None):
    """声の素材から Project を作る（保存はしない）。同期を測り、全員の音がそろっている範囲を1区間にする。
    (Project, SyncResult) を返す。"""
    from .sync import sync_tracks

    out = Path(out)
    base = out.resolve().parent
    names = list(names or [])
    r = sync_tracks(files, reference=0)
    for t in r.tracks:
        for w in getattr(t, "warnings", []):
            log(f"注意（同期）：{Path(t.file).name}：{w}")
    p = Project(name=name or out.stem, sample_rate=audio_io.info(files[0]).sample_rate)
    ids = []
    for i, f in enumerate(files):
        sid = f"voice{i + 1}"
        ids.append(sid)
        rel = Path(f).resolve()
        try:
            rel = rel.relative_to(base)
        except ValueError:
            pass
        p.sources[sid] = Source(path=str(rel), kind="voice")
        p.voices.append(Voice(
            source=sid, name=names[i] if i < len(names) else sid,
            denoise=None if no_denoise else dict(DEFAULT_DENOISE),
        ))
    p.sync = Sync(
        reference=ids[0],
        tracks={
            ids[i]: TrackOffset(t.offset_sec, t.drift_ppm, t.method)
            for i, t in enumerate(r.tracks)
            if not t.is_reference
        },
    )
    start, end = 0.0, audio_io.info(files[0]).duration
    for i, t in enumerate(r.tracks):
        if t.is_reference:
            continue
        d = audio_io.info(files[i]).duration
        k = 1 + t.drift_ppm * 1e-6
        start = max(start, -t.offset_sec / k)
        end = min(end, (d - t.offset_sec) / k)
    p.edit.segments = [Segment(round(start, 6), round(end, 6))]
    return p, r


def assign_names(embs: Dict[str, "np.ndarray"], members: Dict[str, "np.ndarray"]) -> Dict[str, str]:  # noqa: F821
    """声紋が合ったトラックはその人の名前、合わないトラックは ゲスト / ゲスト2 / …。"""
    from . import voiceprint

    got = voiceprint.assign(embs, members, voiceprint.THRESHOLD)
    out, guests = {}, 0
    for sid in embs:
        if got.get(sid):
            out[sid] = got[sid]
        else:
            guests += 1
            out[sid] = "ゲスト" if guests == 1 else f"ゲスト{guests}"
    return out


def create_episode(
    files: Sequence, out_path, preset: Optional[str] = None, name: Optional[str] = None,
    names: Optional[Sequence[str]] = None, no_denoise: bool = False,
    bgm_paths: Optional[Dict[str, Path]] = None, prints: Optional[Dict[str, "np.ndarray"]] = None,  # noqa: F821
    precompute_denoise: bool = False, progress: Optional[Progress] = None,
    log: Callable[[str], None] = lambda s: None,
) -> dict:
    """同期 → プロジェクト作成 →（ノイズ除去 → 話者の割り当て）→ プリセット → 保存。cmd_init とサーバーで共用。

    prints（{名前: 声紋}）があれば、各トラックの声を調べて名前を付け、プリセットの声の設定を名前で当てる。
    bgm_paths（{素材ID: ファイル}）はプリセットの BGM の path を差し替える（op / ed など）。
    返すもの：{"project", "notes", "assigned"（{素材ID: 名前} または None）, "sync"（SyncResult）, "embs"（{素材ID: 声紋} または None）}
    """
    from . import denoise, voiceprint
    from .presets import apply_preset, find_preset, load_preset

    def prog(f, label):
        if progress:
            progress(f, label)

    out = Path(out_path)
    base = out.resolve().parent
    prog(0.0, "音のずれを測っています")
    p, r = init_project(files, out, name, names, no_denoise, log)
    prog(0.12, "音のずれを測りました")

    if (precompute_denoise or prints) and not no_denoise:
        cache = base / CACHE_DIR
        n = len(p.voices)
        for i, v in enumerate(p.voices):
            prog(0.12 + 0.38 * i / n, f"{v.name or v.source} のノイズを除いています（{i + 1}/{n}）")
            denoise.denoised_path(p.source_path(v.source, base), v.denoise, cache)

    assigned = None
    embs = None
    if prints:
        embs = {}
        for i, v in enumerate(p.voices):
            prog(0.5 + 0.05 * i / len(p.voices), f"{v.name or v.source} の声を調べています")
            src = p.source_path(v.source, base)
            if v.denoise:
                src = denoise.denoised_path(src, v.denoise, base / CACHE_DIR)  # 作り済みなのでキャッシュが返る
            embs[v.source] = voiceprint.track_embedding(src)
        assigned = assign_names(embs, prints)
        for v in p.voices:
            v.name = assigned[v.source]

    notes: List[str] = []
    if preset:
        prog(0.56, "プリセットを当てています")
        spec, preset_dir = load_preset(preset)
        p.preset = find_preset(preset).stem
        if bgm_paths:
            spec = dict(spec)
            spec["bgm"] = [{**b, "path": str(bgm_paths[b["source"]])} if b.get("source") in bgm_paths else b
                           for b in spec.get("bgm", [])]
        notes = apply_preset(p, spec, preset_dir, base, r.clap_time_ref_sec,
                             names_given=bool(names) or assigned is not None, voices_by_name=assigned is not None)
    if no_denoise:
        for v in p.voices:
            v.denoise = None
    errs = p.validate()
    if errs:
        raise ValueError("プロジェクトに問題があります：\n" + "\n".join(errs))
    out.parent.mkdir(parents=True, exist_ok=True)
    p.save(out)
    prog(0.6, "プロジェクトを保存しました")
    return {"project": p, "notes": notes, "assigned": assigned, "sync": r, "embs": embs}


# ---------------------------------------------------------------- 終わりの拍手（編集点）

END_CLAP_WINDOW_SEC = 300.0  # 収録の最後のこの範囲で探す
END_CLAP_MIN_RISE_DB = 45.0  # 編集点用の拍手：全員のマイクで鋭く立ち上がる（実測 44〜78 dB。話し声の子音は 15〜25 dB）
END_CLAP_BEFORE_SEC = 0.3  # 拍手のこれだけ前で切る
APPLAUSE_SPAN_SEC = 1.5  # この範囲に強い立ち上がりが3つ以上あれば、ふつうの拍手（何度も手をたたく）とみなす


def find_end_clap(p: Project, base, tr=None, window_sec: float = END_CLAP_WINDOW_SEC) -> Optional[float]:
    """収録の終わりの、編集点用の拍手（基準時刻・秒）。なければ None。

    編集点用の拍手と、ふつうの拍手（拍手喝采）・話し声を、次の決まりで見分ける：
    - 全員のマイク（2本以上なら 2/3 以上）に、50ms 以内のずれで同時に入っている
    - 立ち上がりが鋭い（トラックの中央値で END_CLAP_MIN_RISE_DB 以上）
    - 1回か2回だけ：前後 APPLAUSE_SPAN_SEC に強い立ち上がりが合わせて3つ以上あれば、ふつうの拍手として除く
    - 発言の途中ではない（文字起こしがあれば、発言の中に 0.3 秒以上入り込んでいたら除く）
    見つかったうちいちばん早いもの（その後ろは要らない部分なので）を返す。
    """
    from .sync import detect_transients

    base = Path(base)
    hits: Dict[str, List[tuple]] = {}
    audio = {}
    for v in p.voices:
        audio[v.source] = audio_io.read(p.source_path(v.source, base), mono=True, dtype="float32")
        hits[v.source] = []
    if not audio:
        return None

    def kof(sid):
        off = p.sync.offset(sid)
        return off, 1 + off.drift_ppm * 1e-6

    r1 = min((len(x) / fs - kof(s)[0].offset_sec) / kof(s)[1] for s, (x, fs) in audio.items())
    r0 = max(0.0, r1 - window_sec)
    for v in p.voices:
        off, k = kof(v.source)
        x, fs = audio[v.source]
        f0 = max(0.0, r0 * k + off.offset_sec)
        seg = x[int(f0 * fs):]
        for t in detect_transients(seg, fs, min_rise_db=30.0, min_level_db=-40.0, max_candidates=400):
            hits[v.source].append((((f0 + t.time) - off.offset_sec) / k, t.rise_db))
    srcs = [s for s in hits if hits[s]]
    if len(srcs) < max(1, len(hits) * 2 / 3):
        return None
    need = len(hits) if len(hits) <= 2 else int(np.ceil(len(hits) * 2 / 3))
    strong = sorted(t for s in hits for t, rise in hits[s] if rise >= END_CLAP_MIN_RISE_DB)

    cands = []
    for t, _ in sorted(set(x for s in srcs for x in hits[s])):
        rises = []
        for s in hits:
            near = [rise for u, rise in hits[s] if abs(u - t) <= 0.05]
            if near:
                rises.append(max(near))
        if len(rises) < need or float(np.median(rises)) < END_CLAP_MIN_RISE_DB:
            continue
        if cands and t - cands[-1] < 0.15:  # 同じ拍手を別のトラックから拾い直したもの
            continue
        cands.append(t)
    utts = tr.utterances if tr is not None else []
    for t in cands:
        # 強い立ち上がりを、同じ拍手（50ms 以内）はまとめて数える
        group: List[float] = []
        for u in strong:
            if abs(u - t) <= APPLAUSE_SPAN_SEC and not any(abs(u - g) <= 0.05 for g in group):
                group.append(u)
        if len(group) >= 3:
            continue
        if any(u.start + 0.3 < t < u.end - 0.3 for u in utts):
            continue
        return round(float(t), 3)
    return None


def trim_at_end_clap(p: Project, base, tr=None, before: float = END_CLAP_BEFORE_SEC) -> Optional[tuple]:
    """編集点用の拍手が終わりにあれば、その直前で最後の区間を切る。(拍手の時刻, 切った後の終わり) を返す。"""
    if not p.edit.segments:
        return None
    clap = find_end_clap(p, base, tr)
    if clap is None:
        return None
    last = p.edit.segments[-1]
    new_end = round(clap - before, 3)
    if not (last.start < new_end < last.end):
        return None
    last.end = new_end
    return clap, new_end


def transcribe_and_save(proj_path, trim_end: Optional[float] = None,
                        log: Callable[[str], None] = lambda s: None) -> dict:
    """文字起こしして .transcript.json / .txt を保存し、話の終わりで最後の区間を切る。cmd_transcribe と共用。"""
    from .transcribe import transcribe_project

    proj = Path(proj_path)
    p = Project.load(proj)
    tr = transcribe_project(p, proj.resolve().parent, log=log)
    stem = proj.with_suffix("")
    tr.save(f"{stem}.transcript.json")
    Path(f"{stem}.transcript.txt").write_text(tr.script_text(), encoding="utf-8")
    log(f"{stem}.transcript.json / .txt を作りました（発言 {len(tr.utterances)}）")

    trimmed = None
    clap = trim_at_end_clap(p, proj.resolve().parent, tr)
    if clap is not None:  # 終わりの拍手（編集点）があれば、話の終わりより優先してその直前で切る
        p.save(proj)
        log(f"終わりの拍手（基準時刻 {clap[0]:.2f} 秒）の {END_CLAP_BEFORE_SEC} 秒前で切りました")
        return {"utterances": len(tr.utterances), "trimmed": None, "end_clap": clap[0]}
    pad = trim_end if trim_end is not None else p.edit.end_after_speech_sec
    end = tr.speech_end
    if pad is not None and end is not None and p.edit.segments:
        last = p.edit.segments[-1]
        new_end = round(end + pad, 3)
        if last.start < new_end < last.end:
            before = p.edit.output_end
            last.end = new_end
            p.save(proj)
            trimmed = (end, pad, before, p.edit.output_end)
            log(f"話の終わり（基準時刻 {end:.2f} 秒）の {pad} 秒後で切りました"
                f"（声の終わり {before:.1f} → {p.edit.output_end:.1f} 秒。ED の BGM もついてきます）")
    return {"utterances": len(tr.utterances), "trimmed": trimmed}


# ---------------------------------------------------------------- 要確認（review.json）

REVIEW_FILE = "review.json"
DRIFT_NOTICE_PPM = 50  # これを超えるドリフトは「ありうるが珍しい」ので知らせる
WEAK_MARGIN = 0.03  # しきい値 + これ 未満の一致は「ぎりぎり」
SIGNOFFS = ("ありがとうございました", "さよなら", "よろしくお願いします")
TAIL_NEXT_SEC = 5.0  # 挨拶の後これ以内に次の発言が始まれば「続いている」（12/4 は約4秒あいて収録後の雑談が続いた）
IMBALANCE_RATIO = 0.10
_PUNCT = " 　、。，．,.!！?？ー〜~…\n"
_FILLER_WORDS = ("はい", "どうも", "ありがとう", "ばいばい", "お疲れさまでした", "お疲れ様でした")


def _finding(kind: str, message: str, time: Optional[float] = None, **extra) -> dict:
    """要確認1件。extra（source / name / near など）はそのまま付ける。"""
    d = {"kind": kind, "message": message, "time": None if time is None else round(float(time), 2)}
    d.update(extra)
    return d


def _mmss(t: float) -> str:
    m, s = divmod(float(t), 60)
    return f"{int(m)}:{s:04.1f}"


def load_review(episode_dir) -> List[dict]:
    f = Path(episode_dir) / REVIEW_FILE
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return d if isinstance(d, list) else []


def save_review(episode_dir, findings: List[dict]) -> None:
    f = Path(episode_dir) / REVIEW_FILE
    tmp = f.with_name(f.name + ".tmp")
    tmp.write_text(json.dumps(findings, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(f)


def sync_findings(sync) -> List[dict]:
    """同期の結果から：拍手なし・同期の注意・大きめのドリフト。"""
    out = []
    if sync.clap_time_ref_sec is None:
        out.append(_finding("no_clap", "拍手が見つからず、エピソードの頭を拍手で切れていません。冒頭を確認してください"))
    for t in sync.tracks:
        name = Path(t.file).name
        for w in getattr(t, "warnings", []):
            out.append(_finding("sync_warning", f"{name}：{w}"))
        if not t.is_reference and abs(t.drift_ppm) > DRIFT_NOTICE_PPM:
            out.append(_finding("drift", f"{name}：時計のずれ（ドリフト）が {t.drift_ppm:+.0f} ppm と大きめです。終盤の口の動きと音がずれていないか確認してください"))
    return out


def voiceprint_findings(p: Project, embs: Dict[str, "np.ndarray"], prints: Dict[str, "np.ndarray"]) -> List[dict]:  # noqa: F821
    """声紋との照合から：ゲスト（どのメンバーにも合わない）・ぎりぎりの一致。"""
    from . import voiceprint

    out = []
    if not prints:
        return out
    for v in p.voices:
        emb = embs.get(v.source)
        if emb is None:
            continue
        label = f"{v.name}（{Path(p.sources[v.source].path).name}）"
        name = v.name or ""
        if name in prints:
            s = voiceprint.similarity(emb, prints[name])
            if s < voiceprint.THRESHOLD + WEAK_MARGIN:
                out.append(_finding("weak_match", f"{label} は {name} と判定しましたが点数が低めです（{s:.2f}）。別の人でないか確認してください",
                                    source=v.source, name=name))
        elif name.startswith("ゲスト"):
            near, best = None, -1.0
            for m, e in prints.items():
                s = voiceprint.similarity(emb, e)
                if s > best:
                    near, best = m, s
            out.append(_finding("guest", f"{label} はメンバーの声紋に合いませんでした（{near}に近い（{best:.2f}）がしきい値 {voiceprint.THRESHOLD:.2f} 未満）。ゲストでよいか確認してください",
                                source=v.source, name=name, near=near))
    return out


def _strip_marks(text: str) -> str:
    return text.strip(_PUNCT)


def _meaningful(text: str) -> bool:
    """挨拶やあいづちを除いて、まだ言葉が残るか。"""
    for w in SIGNOFFS + _FILLER_WORDS:
        text = text.replace(w, "")
    return bool(_strip_marks(text))


def tail_chatter_finding(tr) -> Optional[dict]:
    """最後の2発言に締めの挨拶があり、その後も話が続いているように見えたら知らせる。"""
    us = [u for u in tr.utterances if u.script.strip()]
    for i in range(max(0, len(us) - 2), len(us)):
        u = us[i]
        text = "".join(w.w for w in u.words) if u.words else u.text
        text = text.replace(" ", "").replace("　", "")
        pos, phrase = -1, None
        for ph in SIGNOFFS:
            k = text.rfind(ph)
            if k >= 0 and k + len(ph) > pos:
                pos, phrase = k + len(ph), ph
        if phrase is None:
            continue
        rest = _strip_marks(text[pos:])
        if rest:
            t, acc = u.end, 0
            for w in u.words:
                acc += len(w.w.replace(" ", ""))
                if acc >= pos:
                    t = w.t1
                    break
            return _finding("tail_chatter", f"{_mmss(t)} 付近：「{phrase}」のあとにも話が続いているようです（「{rest[:20]}」）。ここまでで終わりなら、その位置で切ってください", t)
        for nxt in us[i + 1:]:
            if nxt.start - u.end <= TAIL_NEXT_SEC and _meaningful(nxt.script):
                return _finding("tail_chatter", f"{_mmss(u.end)} 付近：「{phrase}」の直後に別の発言が続いています（「{_strip_marks(nxt.script)[:20]}」）。ここまでで終わりなら、その位置で切ってください", u.end)
    return None


def imbalance_findings(tr, p: Project) -> List[dict]:
    """トラックごとの発言の長さ。ほかの人の 10% 未満なら、違うファイルや空の可能性。"""
    if len(p.voices) < 2:
        return []
    dur = {v.source: 0.0 for v in p.voices}
    for u in tr.utterances:
        if u.source in dur:
            dur[u.source] += max(0.0, u.end - u.start)
    out = []
    for v in p.voices:
        others = [d for s, d in dur.items() if s != v.source]
        top = max(others)
        if top > 0 and dur[v.source] < IMBALANCE_RATIO * top:
            out.append(_finding("speaker_imbalance", f"{v.name or v.source}の発言が {dur[v.source]:.0f} 秒しかありません（ほかは最大 {top:.0f} 秒）。違うファイルや空のファイルでないか確認してください"))
    return out


def transcript_findings(tr, p: Project) -> List[dict]:
    out = []
    if p.edit.segments:  # 切り落とした後ろの発言（終わりの拍手で切ったあとの雑談など）は見ない
        import copy

        end = p.edit.segments[-1].end
        tr = copy.copy(tr)
        tr.utterances = [u for u in tr.utterances if u.start < end]
    f = tail_chatter_finding(tr)
    if f:
        out.append(f)
    return out + imbalance_findings(tr, p)


REVIEW_LOG = "review_log.jsonl"


def _read_log(program_dir) -> List[dict]:
    f = Path(program_dir) / REVIEW_LOG
    out = []
    try:
        lines = f.read_text(encoding="utf-8").splitlines()
    except OSError:
        return out
    for line in lines:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if isinstance(d, dict):
            out.append(d)
    return out


def past_notes(program_dir, kind: str, limit: int = 3) -> List[dict]:
    """過去の確認ログから、同じ種類でメモのあるもの（新しい順に limit 件）。"""
    hits = [e for e in _read_log(program_dir) if e.get("kind") == kind and (e.get("note") or "").strip()]
    return hits[::-1][:limit]


def attach_hints(program_dir, eid: str, findings: List[dict]) -> List[dict]:
    """各指摘に、同じ種類の前回までのメモ（別のエピソード分）を hints として付ける。"""
    for f in findings:
        hints = [{"episode": e.get("episode"), "note": e["note"]}
                 for e in past_notes(program_dir, f.get("kind", ""), limit=10) if e.get("episode") != eid][:3]
        if hints:
            f["hints"] = hints
        else:
            f.pop("hints", None)
    return findings


_WEAK_RE = re.compile(r"^.*?（(?P<file>[^（）]+)） は (?P<name>.+?) と判定")


def _weak_match_target(base: Path, eid: str, finding: dict) -> Tuple[Optional[str], Optional[str]]:
    """弱い一致の指摘が指す（メンバー名, 素材ID）。項目に name / source がない古い review.json は、
    文（「◯◯（ファイル名） は ◯◯ と判定…」）とプロジェクトの素材のファイル名から求める。"""
    name, source = finding.get("name"), finding.get("source")
    if name and source:
        return name, source
    m = _WEAK_RE.match(str(finding.get("message", "")))
    pp = episode_project_path(base / eid)
    if not m or pp is None:
        return name, source
    p = Project.load(pp)
    sid = next((k for k, src in p.sources.items() if Path(src.path).name == m["file"]), None)
    return name or m["name"], source or sid


def learn_from_review(program_dir, eid: str, finding: dict) -> Optional[str]:
    """指摘を確認済みにしたときの学習。ログに1行足し、声紋が弱い一致ならその声を声紋に足す。
    足したときだけ日本語のメッセージを返す。"""
    from . import voiceprint

    base = Path(program_dir)
    entry = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "episode": eid,
             "kind": finding.get("kind"), "message": finding.get("message"),
             "time": finding.get("time"), "note": finding.get("note") or ""}
    for k in ("source", "name"):
        if finding.get(k):
            entry[k] = finding[k]
    with open(base / REVIEW_LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    if finding.get("kind") != "weak_match":
        return None
    name, source = _weak_match_target(base, eid, finding)
    if not name or not source:
        return None
    try:
        member = next((m for m in load_program(base)["members"] if m["name"] == name), None)
        if member is None or not member.get("voiceprint"):
            return None
        f = inside(base, member["voiceprint"])
        if not f.is_file():
            return None
        old, meta = voiceprint.load_print(f)
        emb, seconds = _track_embedding_for(base, eid, source)
        n = int(meta.get("count", 1))
        eps = list(meta.get("episodes") or ([meta["episode"]] if meta.get("episode") else []))
        eps.append(eid)
        meta.update({"count": n + 1, "episodes": eps,
                     "seconds": round(float(meta.get("seconds", 0)) + float(seconds), 1)})
        voiceprint.save_print(f, voiceprint._unit(np.asarray(old, dtype=np.float64) * n + emb), meta)
    except Exception as e:
        return f"{name}の声紋を強められませんでした（{type(e).__name__}: {e}）"
    day = f"{int(eid[4:6])}/{int(eid[6:8])}" if DATE_RE.match(eid) else eid
    return f"{name}の声紋に {day} の声を足しました（{n + 1} 回分）"


def review_handoff_text(program_dir, eid: str) -> str:
    """要確認を Claude に渡すための文章（Markdown）。"""
    base = Path(program_dir)
    findings = load_review(base / eid)
    date = _date_text(eid) if DATE_RE.match(eid) else eid
    lines = [f"# 要確認の引き継ぎ：{base.name} {date}", "",
             f"- 番組：{base.name}", f"- エピソード：{date}（{eid}）",
             f"- 要確認のファイル：{base / eid / REVIEW_FILE}", ""]
    for i, f in enumerate(findings):
        state = "確認済み" if f.get("resolved") else "未確認"
        t = f" {_mmss(f['time'])}" if f.get("time") is not None else ""
        lines.append(f"## {i + 1}. [{f.get('kind')}] {state}{t}")
        lines.append(str(f.get("message", "")))
        if f.get("note"):
            lines.append(f"- メモ：{f['note']}")
        for h in f.get("hints") or []:
            lines.append(f"- 前回のメモ（{h.get('episode')}）：{h.get('note')}")
        lines.append("")
    if not findings:
        lines += ["（要確認はありません）", ""]
    lines.append(f"メモのある項目について、内容を読んで対応してください。過去の確認の記録は {base / REVIEW_LOG} にあります。")
    return "\n".join(lines) + "\n"


def _carry_resolved(new: List[dict], old: List[dict]) -> List[dict]:
    """同じ種類・同じ文の指摘は、前の「解決済み」を引き継ぐ。"""
    done = {(f.get("kind"), f.get("message")) for f in old if f.get("resolved")}
    notes = {(f.get("kind"), f.get("message")): f["note"] for f in old if f.get("note")}
    for f in new:
        key = (f["kind"], f["message"])
        if key in done:
            f["resolved"] = True
        if key in notes:
            f["note"] = notes[key]
    return new


def review_episode(program_dir, episode_id: str) -> List[dict]:
    """既存のエピソードの「要確認」を作り直して review.json に保存する。
    文字起こし（末尾の雑談・発言の偏り）・声紋（ゲスト・ぎりぎり）・ドリフトはいまの内容から計算し直す。
    拍手・同期の注意は同期をやり直さないと分からないので、前の review.json のものを残す。"""
    from . import voiceprint
    from .transcribe import Transcript

    base = Path(program_dir)
    ep_dir = base / check_name(episode_id, "エピソード")
    proj_path = episode_project_path(ep_dir)
    if proj_path is None:
        raise FileNotFoundError(f"エピソード {episode_id} のプロジェクトがありません")
    p = Project.load(proj_path)
    old = load_review(ep_dir)
    keep = {"no_clap", "sync_warning", "end_clap"}
    out = [f for f in old if f.get("kind") in keep]
    for sid, t in p.sync.tracks.items():
        if abs(t.drift_ppm) > DRIFT_NOTICE_PPM:
            out.append(_finding("drift", f"{Path(p.sources[sid].path).name}：時計のずれ（ドリフト）が {t.drift_ppm:+.0f} ppm と大きめです。終盤の口の動きと音がずれていないか確認してください"))
    prints = program_prints(load_program(base), base)
    if prints:
        try:
            embs = {v.source: voiceprint.track_embedding(_existing_denoised(p, v.source, ep_dir)) for v in p.voices}
            out += voiceprint_findings(p, embs, prints)
        except Exception:  # 声紋が計算できなければ、前の結果を残す
            out += [f for f in old if f.get("kind") in ("guest", "weak_match")]
    tr_path = proj_path.with_suffix(".transcript.json")
    if tr_path.is_file():
        out += transcript_findings(Transcript.load(tr_path), p)
    out = _carry_resolved(out, old)
    attach_hints(base, episode_id, out)
    save_review(ep_dir, out)
    return out


# ---------------------------------------------------------------- 一度きりの移行（library-init）


def library_init(root, program_name: str = "岡田山ラジオ", preset: str = "okadayama",
                 members: Sequence[str] = ("青木さん", "内田さん")) -> dict:
    """番組フォルダに program.json がなければ作る。プリセットの BGM を BGM/ にコピー（ファイル名はそのまま）。"""
    from .presets import load_preset

    d = Path(root) / program_name
    if (d / PROGRAM_FILE).exists():
        return load_program(d)
    spec, preset_dir = load_preset(preset)
    (d / BGM_DIR).mkdir(parents=True, exist_ok=True)
    (d / PRINT_DIR).mkdir(exist_ok=True)
    bgm = {}
    for b in spec.get("bgm", []):
        src = (preset_dir / b["path"]).resolve()
        if not src.is_file():
            raise FileNotFoundError(f"BGM {b['source']!r} のファイルが見つかりません：{src}")
        dst = d / BGM_DIR / src.name
        if not dst.exists():
            shutil.copy2(src, dst)
        bgm[b["source"]] = f"{BGM_DIR}/{src.name}"
    prog = {"format": PROGRAM_FORMAT, "version": 1, "name": program_name, "preset": preset, "bgm": bgm,
            "members": [{"name": m, "role": "mc"} for m in members]}
    save_program(d, prog)
    return prog
