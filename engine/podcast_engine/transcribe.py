"""文字起こし（mlx-whisper ＋ Whisper large-v3-turbo、Mac の GPU で実行）。

流れ
1. 声トラックごとに、ノイズ除去済みの素材（なければ元の素材）を書き起こす。結果は .podcache/ に保存
2. 単語（日本語ではほぼ1文字）の時刻を、各トラックの時刻から「基準時刻」に直す
3. 話者を決める：同じ時刻の各トラックの音量（声の音量調整後）を比べ、一番大きいトラックの言葉だけ残す。
   相手のマイクに入ったかぶりを書き起こした分はここで捨てる
4. 同じ話者の言葉を、間が空くまで1つの発言にまとめる
5. フィラー（えー、あのー など）に印を付ける。台本はフィラーを除いた文、ルビはフィラー込み

出力（.transcript.json）の時刻はすべて基準時刻（カットの edit.segments と同じ物差し）。
Claude に読ませるのは文単位の台本（.transcript.txt）にして、トークンを抑える。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import audio_io
from .project import CACHE_DIR, Project

MODEL = "mlx-community/whisper-large-v3-turbo"
WHISPER_FS = 16000
CACHE_VERSION = 1
FORMAT = "podtranscript"

# 話者の判定：一番大きいトラックからこの dB 以内なら「そのトラックの声」とみなす
SPEAKER_MARGIN_DB = 3.0
# 発言の区切り：同じ話者でも、この秒数以上あいたら別の発言にする
UTTERANCE_GAP_SEC = 0.7
ENV_HOP_SEC = 0.02  # 音量を見る細かさ
# 話の終わりの判定：最後の発言の前にこれ以上の間があり、確からしさが低ければ収録後の雑談とみなす
TAIL_GAP_SEC = 2.0
TAIL_MIN_PROB = 0.6

# フィラー（言いよどみ）。台本からは除き、ルビには残す
FILLER_RE = re.compile(
    r"(えーっと|えっと|ええと|えーと|えー+|あのー+|あの(?=[、。,\s]|$)|そのー+|あー+|うーん|うー+|んー+|"
    r"まあ(?=[、,\s])|なんか(?=[、,\s]))"
)


# ---------------------------------------------------------------- データ


@dataclass
class Word:
    t0: float  # 基準時刻（秒）
    t1: float
    w: str
    p: float = 1.0  # 確からしさ（0〜1）
    filler: bool = False


@dataclass
class Utterance:
    speaker: str
    source: str
    start: float
    end: float
    text: str  # フィラー込み（ルビ用）
    script: str  # フィラー抜き（台本用）
    words: List[Word] = field(default_factory=list)


@dataclass
class Transcript:
    model: str
    language: str
    utterances: List[Utterance] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"format": FORMAT, "version": 1, **asdict(self)}

    @classmethod
    def from_dict(cls, d: dict) -> "Transcript":
        if d.get("format") != FORMAT:
            raise ValueError("文字起こしのファイルではありません")
        return cls(
            model=d["model"], language=d["language"],
            utterances=[
                Utterance(**{**u, "words": [Word(**w) for w in u["words"]]}) for u in d["utterances"]
            ],
        )

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> "Transcript":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    def script_text(self) -> str:
        """台本（フィラー抜き、発言ごとに1行、時刻は基準時刻）。Claude に読ませる形。"""
        lines = []
        for u in self.utterances:
            if u.script.strip():
                # 時刻は最初の「フィラーでない言葉」（台本で見るのはそこから）
                t = next((w.t0 for w in u.words if not w.filler), u.start)
                m, s = divmod(t, 60)
                lines.append(f"[{int(m):02d}:{s:04.1f}] {u.speaker}：{u.script}")
        return "\n".join(lines) + "\n"

    @property
    def speech_end(self) -> Optional[float]:
        """話の終わり（基準時刻）。

        収録の後の雑談（例：9/25 の「さよなら」の後の「はいではい私第2回…」）は除く：
        最後の発言の前に TAIL_GAP_SEC 以上の間があり、確からしさの平均が TAIL_MIN_PROB 未満なら、
        本編の後の声とみなして、その前までを話とする（後ろから順に見る）。
        """
        us = [u for u in self.utterances if u.script.strip()]
        while len(us) >= 2:
            last, prev = us[-1], us[-2]
            prob = float(np.mean([w.p for w in last.words])) if last.words else 1.0
            if last.start - prev.end >= TAIL_GAP_SEC and prob < TAIL_MIN_PROB:
                us = us[:-1]
            else:
                break
        return max(u.end for u in us) if us else None


# ---------------------------------------------------------------- Whisper


def _whisper(audio16: np.ndarray, prompt: Optional[str]) -> dict:
    import mlx_whisper

    return mlx_whisper.transcribe(
        audio16, path_or_hf_repo=MODEL, language="ja", word_timestamps=True,
        condition_on_previous_text=False,  # 同じ文の繰り返し（幻聴）を防ぐ
        initial_prompt=prompt,
    )


def _prepare_audio(path: Path) -> np.ndarray:
    """16kHz モノラルにして、聞き取りやすい大きさ（ピーク -1dB）にそろえる。"""
    x, fs = audio_io.read(path, mono=True, dtype="float32")
    x = audio_io.resample(x, fs, WHISPER_FS).astype(np.float32)
    peak = float(np.max(np.abs(x), initial=0.0))
    return x * np.float32(0.89 / peak) if peak > 0 else x


def _keep_segment(s: dict) -> bool:
    """Whisper の幻聴（無音から文をでっち上げる）らしい区切りを捨てる。"""
    if not s.get("text", "").strip():
        return False
    if s.get("compression_ratio", 0) > 2.4:  # 同じ文字の繰り返し
        return False
    if s.get("no_speech_prob", 0) > 0.6 and s.get("avg_logprob", 0) < -1.0:
        return False
    return True


def transcribe_source(path: Path, cache_dir: Path, prompt: Optional[str] = None) -> List[dict]:
    """1つの素材ファイルを書き起こし、単語のリスト（ファイル内の時刻）を返す。キャッシュあり。"""
    st = path.stat()
    key = hashlib.sha256(json.dumps(
        {"p": str(path.resolve()), "s": st.st_size, "m": st.st_mtime, "model": MODEL,
         "prompt": prompt, "v": CACHE_VERSION}, sort_keys=True).encode()).hexdigest()[:20]
    out = cache_dir / f"{path.stem}.whisper-{key}.json"
    if out.exists():
        return json.loads(out.read_text(encoding="utf-8"))
    r = _whisper(_prepare_audio(path), prompt)
    words = []
    for s in r["segments"]:
        if not _keep_segment(s):
            continue
        for w in s.get("words", []):
            if w["word"].strip():
                words.append({"t0": float(w["start"]), "t1": float(w["end"]), "w": w["word"].strip(),
                              "p": float(w.get("probability", 1.0))})
    cache_dir.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".tmp.json")
    tmp.write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, out)
    return words


# ---------------------------------------------------------------- 話者の判定


def level_envelope(project: Project, source_id: str, path: Path, start: float, end: float,
                   gain_db: float) -> np.ndarray:
    """基準時刻 start〜end の音量（dB、ENV_HOP_SEC ごと）。声の音量調整（gain_db）込み。"""
    off = project.sync.offset(source_id)
    k = 1 + off.drift_ppm * 1e-6
    a = start * k + off.offset_sec
    b = end * k + off.offset_sec
    n = int(np.ceil((end - start) / ENV_HOP_SEC))
    env = np.full(n, -120.0)
    info = audio_io.info(path)
    hop = int(round(ENV_HOP_SEC * info.sample_rate * k))
    chunk = hop * 3000  # 約60秒ずつ
    pos, i = a, 0
    while i < n:
        frames = min(chunk, (n - i) * hop)
        lo = int(round(pos * info.sample_rate))
        x = np.zeros(frames, dtype=np.float32)
        ra, rb = max(lo, 0), min(lo + frames, info.frames)
        if rb > ra:
            y, _ = audio_io.read(path, ra / info.sample_rate, rb / info.sample_rate, mono=True)
            x[ra - lo : ra - lo + len(y)] = y[: rb - ra]
        m = len(x) // hop
        p = (x[: m * hop].reshape(m, hop) ** 2).mean(axis=1)
        env[i : i + m] = 10 * np.log10(p + 1e-12) + gain_db
        i += m
        pos += m * hop / info.sample_rate
        if m == 0:
            break
    return env


PHRASE_GAP_SEC = 0.3  # 話者の判定は、この間隔より詰まった言葉のまとまり（フレーズ）ごとに行う


def _phrases(words: List[Word], gap: float = PHRASE_GAP_SEC) -> List[List[Word]]:
    out: List[List[Word]] = []
    for w in words:
        if out and w.t0 - out[-1][-1].t1 <= gap:
            out[-1].append(w)
        else:
            out.append([w])
    return out


def assign_speakers(
    words_by_source: Dict[str, List[Word]], env_by_source: Dict[str, np.ndarray], env_start: float,
    margin_db: float = SPEAKER_MARGIN_DB,
) -> Dict[str, List[Word]]:
    """各トラックの言葉のうち、その時刻にそのトラックの声が一番大きいものだけ残す。

    1文字ずつ比べると、言葉の頭の1文字だけ両方のトラックに残る（「最」「最初の」）ので、
    間の詰まった言葉のまとまり（フレーズ）ごとに比べる。他のトラックより margin_db 以上小さい
    フレーズは、相手の声のかぶりとして捨てる。両方残ったフレーズが時間で重なるときは、大きい方だけ残す。
    """
    ids = list(words_by_source)

    def level(o: str, t0: float, t1: float) -> float:
        i0 = max(0, int((t0 - env_start) / ENV_HOP_SEC))
        i1 = max(i0 + 1, int(np.ceil((t1 - env_start) / ENV_HOP_SEC)))
        seg = env_by_source[o][i0:i1]
        return float(10 * np.log10(np.mean(10 ** (seg / 10)))) if seg.size else -120.0

    cands = []  # (話者, フレーズ, 自分の音量 − 他の最大)
    for sid in ids:
        for ph in _phrases(words_by_source[sid]):
            t0, t1 = ph[0].t0, ph[-1].t1
            own = level(sid, t0, t1)
            other = max((level(o, t0, t1) for o in ids if o != sid), default=-120.0)
            if own >= other - margin_db:
                cands.append((sid, ph, own - other))
    # 重なるフレーズは、差の大きい（よりはっきりそのトラックの声である）方を優先し、
    # 後から来たフレーズは「重なっている言葉」だけ捨てる（長いフレーズを丸ごと捨てないため）
    cands.sort(key=lambda c: -c[2])
    kept: List[tuple] = []  # (話者, 言葉のリスト, 開始, 終わり)
    for sid, ph, _ in cands:
        spans = [(k[2], k[3]) for k in kept if k[0] != sid]
        rest = [w for w in ph if not any(w.t0 < b and a < w.t1 for a, b in spans)]
        if rest:
            kept.append((sid, rest, rest[0].t0, rest[-1].t1))
    out: Dict[str, List[Word]] = {sid: [] for sid in ids}
    for sid, ph, _, _ in kept:
        out[sid] += ph
    for sid in ids:
        out[sid].sort(key=lambda w: w.t0)
    return out


# ---------------------------------------------------------------- 発言にまとめる・フィラー


def apply_corrections(words: List[Word], corrections: Dict[str, str]) -> List[Word]:
    """決めておいた言い換えで直す（例：「ルチャリブロ」→「ルチャ・リブロ」）。

    Whisper に最初に言葉を見せる方法（プロンプト）は、プロンプトをそのまま出力したり、
    関係ない言葉を置き換えたりしたので使わない。直した言葉は、元の言葉たちの時刻をまとめて持つ。
    """
    if not corrections or not words:
        return words
    pat = re.compile("|".join(re.escape(k) for k in sorted(corrections, key=len, reverse=True)))
    text = ""
    owner: List[int] = []  # 各文字がどの単語のものか
    starts: List[int] = []  # 各単語の先頭の文字位置
    for i, w in enumerate(words):
        starts.append(len(text))
        text += w.w
        owner += [i] * len(w.w)
    out: List[Word] = []
    i = 0  # 次に見る単語
    for m in pat.finditer(text):  # 元の文字列を左から1回だけ探すので、直した後の文字は探し直さない
        i0, i1 = owner[m.start()], owner[m.end() - 1]
        if i0 < i:  # 前の置き換えと重なる
            continue
        out += words[i:i0]
        # 一致した部分の前後に、同じ単語の中の余った文字があれば残す
        head = text[starts[i0] : m.start()]
        tail = text[m.end() : starts[i1] + len(words[i1].w)]
        out.append(Word(words[i0].t0, words[i1].t1, head + corrections[m.group()] + tail,
                        min(w.p for w in words[i0 : i1 + 1])))
        i = i1 + 1
    return out + words[i:]


def mark_fillers(words: List[Word]) -> None:
    """発言の文字列でフィラーを探し、重なる単語に印を付ける。"""
    text = ""
    owner: List[int] = []
    for i, w in enumerate(words):
        text += w.w
        owner += [i] * len(w.w)
    for m in FILLER_RE.finditer(text):
        for c in range(m.start(), m.end()):
            words[owner[c]].filler = True


def build_utterances(
    words_by_source: Dict[str, List[Word]], names: Dict[str, str], gap: float = UTTERANCE_GAP_SEC,
    corrections: Optional[Dict[str, str]] = None,
) -> List[Utterance]:
    allw = sorted(((w, sid) for sid, ws in words_by_source.items() for w in ws), key=lambda x: x[0].t0)
    utts: List[Utterance] = []
    cur: List[Word] = []
    cur_sid = None
    def flush():
        if cur:
            ws = apply_corrections(list(cur), corrections or {})
            mark_fillers(ws)
            text = "".join(w.w for w in ws)
            script = "".join(w.w for w in ws if not w.filler)
            script = re.sub(r"^[、,\s]+", "", script)
            utts.append(Utterance(names.get(cur_sid, cur_sid), cur_sid, ws[0].t0, ws[-1].t1, text, script, ws))
    for w, sid in allw:
        if cur and (sid != cur_sid or w.t0 - cur[-1].t1 > gap):
            flush()
            cur = []
        cur.append(w)
        cur_sid = sid
    flush()
    return utts


# ---------------------------------------------------------------- まとめ


def transcribe_project(project: Project, base_dir: str | Path, prompt: Optional[str] = None,
                       log=lambda s: None) -> Transcript:
    from .denoise import denoised_path

    base_dir = Path(base_dir)
    cache = base_dir / CACHE_DIR
    segs = project.edit.segments
    if not segs:
        raise ValueError("使う区間（edit.segments）がありません")
    start = min(s.start for s in segs)
    end = max(s.end for s in segs)
    words: Dict[str, List[Word]] = {}
    envs: Dict[str, np.ndarray] = {}
    names = {}
    for v in project.voices:
        if v.mute:
            continue
        src = project.source_path(v.source, base_dir)
        path = denoised_path(src, v.denoise, cache) if v.denoise else src
        log(f"{v.name or v.source}：文字起こし中…")
        raw = transcribe_source(path, cache, prompt)
        off = project.sync.offset(v.source)
        k = 1 + off.drift_ppm * 1e-6
        to_ref = lambda t: (t - off.offset_sec) / k
        ws = [Word(round(to_ref(w["t0"]), 3), round(to_ref(w["t1"]), 3), w["w"], round(w["p"], 3)) for w in raw]
        words[v.source] = [w for w in ws if start - 1 <= w.t0 <= end + 1]
        envs[v.source] = level_envelope(project, v.source, path, start, end, v.gain_db)
        names[v.source] = v.name or v.source
    kept = assign_speakers(words, envs, start)
    return Transcript(model=MODEL, language="ja",
                      utterances=build_utterances(kept, names, corrections=project.corrections))
