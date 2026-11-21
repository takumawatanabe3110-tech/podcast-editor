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
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

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


def enroll_voiceprint(
    program_dir, name: str, episode: str, source: str, role: Optional[str] = None,
    max_seconds: float = 120,
) -> dict:
    """エピソードの1トラックから声紋を作り、番組のメンバーに登録する。メンバー（dict）を返す。

    ノイズ除去済みのキャッシュがあればそれを使う。文字起こしがあり、そのトラックの話者の発言があれば、
    その区間（長い順）だけを使う。なければ音量の大きい部分。
    """
    from . import voiceprint
    from .transcribe import Transcript

    base = Path(program_dir)
    check_name(name, "メンバー名")
    if role is not None and role not in ROLES:
        raise ValueError(f"role は {' / '.join(ROLES)} のどちらかです")
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
    返すもの：{"project", "notes", "assigned"（{素材ID: 名前} または None）}
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
    return {"project": p, "notes": notes, "assigned": assigned}


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

    pad = trim_end if trim_end is not None else p.edit.end_after_speech_sec
    end = tr.speech_end
    trimmed = None
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
