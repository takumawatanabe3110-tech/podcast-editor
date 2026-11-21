"""プロジェクトから完成版の音声を組み立てて書き出す。

処理順（Resolve / Fairlight の流れに合わせる）
  声トラックごと：ノイズ除去（素材全体、キャッシュ）→ 同期 → カット（区間をつなぐ）→ 音量
                  → エフェクト（EQ・コンプ）→ パン
  BGM：クリップごとに位置・音量カーブ・フェード → BGM トラックのエフェクト
  全体：声＋BGM を足す → マスターのエフェクト（Bus 1）
        → ラウドネスを output.loudness_lufs にそろえ、リミッターでトゥルーピークを抑える
        → WAV / MP3 に書き出す
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from . import audio_io
from .effects import make_chain
from .loudness import normalize
from .project import BgmClip, Project, Voice


@dataclass
class RenderReport:
    duration: float
    sample_rate: int
    peak_dbfs: float  # 0 を超えると MP3 で音割れする
    clipped: bool
    loudness_before_lufs: Optional[float] = None  # ラウドネス調整の前
    loudness_lufs: Optional[float] = None  # 書き出した音のラウドネス
    true_peak_dbtp: Optional[float] = None


Progress = Callable[[float, str], None]  # (0〜1 の進み具合, 短い説明)


class _Prog:
    """進み具合を 0〜1 の範囲で後戻りしないように伝える。progress が None なら何もしない。"""

    def __init__(self, cb: Optional[Progress]):
        self.cb, self.last = cb, 0.0

    def __call__(self, frac: float, label: str) -> None:
        self.last = max(self.last, min(1.0, max(0.0, frac)))
        if self.cb:
            self.cb(self.last, label)


def scaled(cb: Optional[Progress], lo: float, hi: float) -> Optional[Progress]:
    """0〜1 の進みを lo〜hi の範囲に押し込む（render と write をつなぐ用）。"""
    if cb is None:
        return None
    return lambda f, label: cb(lo + (hi - lo) * f, label)


def _db(x: float) -> float:
    return float(10 ** (x / 20))


def _read_any(path: Path) -> tuple:
    """WAV/FLAC は soundfile、MP3 などは pedalboard で読む。(channels, n) と fs を返す。"""
    if path.suffix.lower() in (".wav", ".flac", ".aif", ".aiff"):
        x, fs = audio_io.read(path, dtype="float32")
        return x.T, fs
    from pedalboard.io import AudioFile

    with AudioFile(str(path)) as f:
        return f.read(f.frames).astype(np.float32), int(f.samplerate)


def _read_range_padded(path: Path, start: float, stop: float, fs_file: int, frames: int) -> np.ndarray:
    """start〜stop 秒（ファイル内の時刻）を読む。ファイルの外は無音で埋める。モノラル。"""
    a = int(round(start * fs_file))
    b = int(round(stop * fs_file))
    out = np.zeros(max(0, b - a), dtype=np.float32)
    ra, rb = max(a, 0), min(b, frames)
    if rb > ra:
        x, _ = audio_io.read(path, ra / fs_file, rb / fs_file, mono=True, dtype="float32")
        n = min(len(x), rb - ra)
        out[ra - a : ra - a + n] = x[:n]
    return out


def voice_keyframe_gain_db(keyframes, ref_times) -> np.ndarray:
    """声の音量カーブ（dB）を元の素材の時刻 ref_times（秒）で評価する。
    BGM と同じ：点の間は dB で直線補間、最初より前・最後より後は端の値を保つ。空なら 0dB。"""
    ref = np.asarray(ref_times, dtype=np.float64)
    if not keyframes:
        return np.zeros(ref.shape, dtype=np.float64)
    kf = sorted(keyframes, key=lambda k: k.t)
    return np.interp(ref, [k.t for k in kf], [k.db for k in kf])


def render_voice(project: Project, voice: Voice, base_dir: str | Path, length: int) -> np.ndarray:
    """1本の声トラックを、同期とカットを反映して出力時刻に並べる（モノラル、音量・パン前）。"""
    fs = project.sample_rate
    path = project.source_path(voice.source, base_dir)
    if voice.denoise:  # ノイズ除去済みの素材（キャッシュ）に差し替える。時刻は元の素材と同じ
        from .denoise import denoised_path
        from .project import CACHE_DIR

        path = denoised_path(path, voice.denoise, Path(base_dir) / CACHE_DIR)
    inf = audio_io.info(path)
    off = project.sync.offset(voice.source)
    xf = int(round(project.edit.crossfade_ms / 1000 * fs))
    out = np.zeros(length, dtype=np.float32)
    layout = project.edit.layout()

    def to_file(t: float) -> float:
        return t + off.offset_sec + off.drift_ppm * 1e-6 * t

    for i, (out_start, seg) in enumerate(layout):
        n = int(round(seg.length * fs))
        x = _read_range_padded(path, to_file(seg.start), to_file(seg.end), inf.sample_rate, inf.frames)
        # サンプリングレートの違い・ドリフトをここで吸収。四捨五入による1サンプルの差は詰めるだけ
        if inf.sample_rate != fs or abs(len(x) - n) > 1:
            x = audio_io.resample(x, len(x), n).astype(np.float32)
        x = np.pad(x, (0, max(0, n - len(x))))[:n]
        if voice.keyframes:  # 音量カーブ：元の素材の時刻で評価する（カットで出力時刻がずれても同じ位置に効く）
            g = voice_keyframe_gain_db(voice.keyframes, seg.start + np.arange(n) / fs)
            x *= (10 ** (g / 20)).astype(np.float32)
        if i > 0 and xf > 0:
            x[:xf] *= np.linspace(0, 1, xf, endpoint=False, dtype=np.float32)
        if i < len(layout) - 1 and xf > 0:
            x[-xf:] *= np.linspace(1, 0, xf, endpoint=False, dtype=np.float32)
        a = int(round(out_start * fs))
        b = min(length, a + n)
        if b > a:
            out[a:b] += x[: b - a]
    return out


def bgm_envelope(clip: BgmClip, n: int, fs: int) -> np.ndarray:
    """BGM クリップの音量（倍率）。gain_db ＋ キーフレーム（dBで直線補間）＋ フェード。"""
    t = np.arange(n) / fs
    db = np.full(n, clip.gain_db, dtype=np.float64)
    if clip.keyframes:
        kf = sorted(clip.keyframes, key=lambda k: k.t)
        db += np.interp(t, [k.t for k in kf], [k.db for k in kf])
    env = 10 ** (db / 20)
    if clip.fade_in > 0:  # フェードアウトを時間で裏返した形
        u = np.clip(1 - t / clip.fade_in, 0, 1)  # 残りの割合
        env *= 1 - u ** clip.fade_in_curve
    if clip.fade_out > 0:
        u = np.clip(1 - (clip.duration - t) / clip.fade_out, 0, 1)  # 経過の割合
        env *= 1 - u ** clip.fade_out_curve
    return env.astype(np.float32)


def render_bgm(project: Project, clip: BgmClip, base_dir: str | Path, channels: int) -> np.ndarray:
    fs = project.sample_rate
    x, fs_file = _read_any(project.source_path(clip.source, base_dir))
    a = int(round(clip.offset_in * fs_file))
    b = int(round((clip.offset_in + clip.duration) * fs_file))
    x = x[:, a:b]
    if fs_file != fs:
        x = audio_io.resample(x.T, fs_file, fs).T.astype(np.float32)
    n = int(round(clip.duration * fs))
    x = np.pad(x, ((0, 0), (0, max(0, n - x.shape[1]))))[:, :n]
    if x.shape[0] != channels:
        x = np.repeat(x.mean(axis=0, keepdims=True), channels, axis=0)
    return x * bgm_envelope(clip, n, fs)


# 進み具合の重み。岡田山ラジオ（約23分・48kHz ステレオ・MP3）の実測（全体 約79秒）：
#   声を並べる＋エフェクト 9秒 / BGM 2秒 / マスター・変換 1秒 / ラウドネス調整 18秒 → render 31秒（39%）
#   MP3 1回目（書く＋測る）12秒 / 補正1回（調整＋書く＋測る）約31秒 / 最後の測定 5秒 → write 48秒（61%）
RENDER_WEIGHT = 0.39  # 書き出し全体のうち render が占める割合（残りは write）


def render(project: Project, base_dir: str | Path, progress: Optional[Progress] = None) -> tuple:
    """(channels, n) の float32 配列と RenderReport を返す。
    progress(0〜1, 説明) を渡すと、声ごと・BGM ごと・エフェクト・ラウドネス調整のたびに呼ぶ。"""
    prog = _Prog(progress)
    prog(0.0, "準備しています")
    errs = project.validate()
    if errs:
        raise ValueError("プロジェクトに問題があります：\n" + "\n".join(errs))
    fs = project.sample_rate
    ch = project.output.channels
    end = project.edit.output_end if project.voices else 0.0
    for c in project.bgm:
        end = max(end, project.bgm_start(c) + c.duration)
    length = int(round(end * fs))
    mix = np.zeros((ch, length), dtype=np.float32)

    # render 内の割合：声 0〜0.29、BGM 〜0.35、マスター・変換 〜0.39、ラウドネス 〜1.0
    voices = [v for v in project.voices if not v.mute]
    for vi, v in enumerate(voices):
        a0 = 0.29 * vi / len(voices)
        step = 0.29 / len(voices)
        prog(a0, "声を並べています")
        x = render_voice(project, v, base_dir, length) * _db(v.gain_db)
        prog(a0 + step * 0.4, "エフェクト")
        if v.effects:
            x = make_chain(v.effects, fs)(x[None, :])[0]
        prog(a0 + step, "エフェクト")
        if ch == 1:
            mix[0] += x
        else:  # 等パワーのパン（中央で各チャンネル -3dB）
            ang = (np.clip(v.pan, -1, 1) + 1) * np.pi / 4
            mix[0] += x * np.cos(ang)
            mix[1] += x * np.sin(ang)

    if project.bgm:
        bus = np.zeros_like(mix)
        for ci, c in enumerate(project.bgm):
            prog(0.29 + 0.06 * ci / len(project.bgm), "BGM を並べています")
            y = render_bgm(project, c, base_dir, ch)
            a = int(round(project.bgm_start(c) * fs))
            if a < 0:  # 出力の 0 秒より前に始まる分は切り捨てる
                y, a = y[:, -a:], 0
            b = min(length, a + y.shape[1])
            if b > a:
                bus[:, a:b] += y[:, : b - a]
        if project.bgm_effects:
            bus = make_chain(project.bgm_effects, fs)(bus)
        mix += bus
        del bus

    prog(0.35, "エフェクト")
    if project.master_effects:
        mix = make_chain(project.master_effects, fs)(mix)

    out = project.output
    if out.sample_rate != fs:
        mix = audio_io.resample(mix.T, fs, out.sample_rate).T.astype(np.float32)
    fs_out = out.sample_rate

    before = after = tp = None
    prog(0.39, "音の大きさをそろえています")
    if out.loudness_lufs is not None and mix.size:
        mix, before, after, tp = normalize(mix, fs_out, out.loudness_lufs, out.true_peak_dbtp)

    prog(1.0, "音の大きさをそろえています")
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    report = RenderReport(
        duration=mix.shape[1] / fs_out,
        sample_rate=fs_out,
        peak_dbfs=20 * np.log10(peak) if peak > 0 else -np.inf,
        clipped=peak > 1.0,
        loudness_before_lufs=before,
        loudness_lufs=after,
        true_peak_dbtp=tp,
    )
    return mix, report


def _encode_mp3(path: Path, audio: np.ndarray, fs: int, kbps: int) -> np.ndarray:
    """MP3 に書き、読み直した音を返す（測り直し用）。"""
    from pedalboard.io import AudioFile

    with AudioFile(str(path), "w", fs, audio.shape[0], quality=int(kbps)) as f:
        f.write(audio)
    with AudioFile(str(path)) as f:
        return f.read(f.frames)


def write(
    path: str | Path,
    audio: np.ndarray,
    fs: int,
    mp3_kbps: Optional[int] = 128,
    loudness_lufs: Optional[float] = None,
    true_peak_dbtp: Optional[float] = None,
    progress: Optional[Progress] = None,
) -> Optional[tuple]:
    """拡張子で形式を決める。.wav は 32bit float、.mp3 は CBR（固定ビットレート）。

    MP3 で loudness_lufs を指定すると、書いた MP3 を読み直して測り、ずれを補正して書き直す。
    - ラウドネス：MP3 は高域を削るので少し下がる → その分だけ音量を上げる
    - トゥルーピーク：MP3 化でピークが上がることがある → 全体の音量は下げずに、
      MP3 にする前のリミッターの上限をその分だけ下げる（ラウドネスを保ったまま音割れを防ぐ）
    戻り値：MP3 で補正したときは (LUFS, dBTP)。それ以外は None。
    """
    from .loudness import integrated_loudness, normalize, true_peak_dbtp as measure_tp

    prog = _Prog(progress)
    path = Path(path)
    if path.suffix.lower() != ".mp3":
        import soundfile as sf

        prog(0.0, "WAV に書いています")
        sf.write(str(path), audio.T, fs, subtype="FLOAT")
        prog(1.0, "WAV に書いています")
        return None

    kbps = int(mp3_kbps or 128)
    # write 内の割合：1回目の MP3 化と測定 0〜0.25、補正1回で 〜0.625、2回で 〜0.8、3回で 〜0.9。
    # 補正が要らなければ（または早く終われば）最後に 1.0 へ飛ぶ
    q = 0.25 if loudness_lufs is not None else 1.0
    prog(0.0, "MP3 にしています")
    decoded = _encode_mp3(path, audio, fs, kbps)
    if loudness_lufs is None:
        prog(1.0, "MP3 にしています")
        return None
    prog(q * 0.5, "MP3 の音量を測っています")
    # MP3 化によるラウドネスの差（offset）とピークの上がり分を測り、MP3 にする前の音を
    # 「目標 − offset」に正確に合わせ直す（リミッターを強めた分のラウドネス低下も normalize が補う）
    ceiling = true_peak_dbtp if true_peak_dbtp is not None else 0.0
    pre, pre_lufs = audio, integrated_loudness(audio, fs)
    for it in range(4):
        lufs, tp = integrated_loudness(decoded, fs), measure_tp(decoded, fs)
        loud_ok = abs(loudness_lufs - lufs) <= 0.1
        peak_ok = true_peak_dbtp is None or tp <= true_peak_dbtp + 0.05
        if loud_ok and peak_ok:
            break
        base = q + (1 - q) * (0.0, 0.5, 0.73, 0.87)[min(it, 3)]
        prog(base, f"MP3 にしています（{it + 2}回目）")
        offset = lufs - pre_lufs
        if not peak_ok:
            ceiling -= tp - true_peak_dbtp + 0.05
        pre, _, pre_lufs, _ = normalize(audio, fs, loudness_lufs - offset, ceiling)
        decoded = _encode_mp3(path, pre, fs, kbps)
    prog(1.0, "MP3 にしています")
    return integrated_loudness(decoded, fs), measure_tp(decoded, fs)
