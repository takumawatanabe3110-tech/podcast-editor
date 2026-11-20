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
from typing import Optional

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


def render(project: Project, base_dir: str | Path) -> tuple:
    """(channels, n) の float32 配列と RenderReport を返す。"""
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

    for v in project.voices:
        if v.mute:
            continue
        x = render_voice(project, v, base_dir, length) * _db(v.gain_db)
        if v.effects:
            x = make_chain(v.effects, fs)(x[None, :])[0]
        if ch == 1:
            mix[0] += x
        else:  # 等パワーのパン（中央で各チャンネル -3dB）
            ang = (np.clip(v.pan, -1, 1) + 1) * np.pi / 4
            mix[0] += x * np.cos(ang)
            mix[1] += x * np.sin(ang)

    if project.bgm:
        bus = np.zeros_like(mix)
        for c in project.bgm:
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

    if project.master_effects:
        mix = make_chain(project.master_effects, fs)(mix)

    out = project.output
    if out.sample_rate != fs:
        mix = audio_io.resample(mix.T, fs, out.sample_rate).T.astype(np.float32)
    fs_out = out.sample_rate

    before = after = tp = None
    if out.loudness_lufs is not None and mix.size:
        mix, before, after, tp = normalize(mix, fs_out, out.loudness_lufs, out.true_peak_dbtp)

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
) -> Optional[tuple]:
    """拡張子で形式を決める。.wav は 32bit float、.mp3 は CBR（固定ビットレート）。

    MP3 で loudness_lufs を指定すると、書いた MP3 を読み直して測り、ずれを補正して書き直す。
    - ラウドネス：MP3 は高域を削るので少し下がる → その分だけ音量を上げる
    - トゥルーピーク：MP3 化でピークが上がることがある → 全体の音量は下げずに、
      MP3 にする前のリミッターの上限をその分だけ下げる（ラウドネスを保ったまま音割れを防ぐ）
    戻り値：MP3 で補正したときは (LUFS, dBTP)。それ以外は None。
    """
    from .loudness import integrated_loudness, normalize, true_peak_dbtp as measure_tp

    path = Path(path)
    if path.suffix.lower() != ".mp3":
        import soundfile as sf

        sf.write(str(path), audio.T, fs, subtype="FLOAT")
        return None

    kbps = int(mp3_kbps or 128)
    decoded = _encode_mp3(path, audio, fs, kbps)
    if loudness_lufs is None:
        return None
    # MP3 化によるラウドネスの差（offset）とピークの上がり分を測り、MP3 にする前の音を
    # 「目標 − offset」に正確に合わせ直す（リミッターを強めた分のラウドネス低下も normalize が補う）
    ceiling = true_peak_dbtp if true_peak_dbtp is not None else 0.0
    pre, pre_lufs = audio, integrated_loudness(audio, fs)
    for _ in range(4):
        lufs, tp = integrated_loudness(decoded, fs), measure_tp(decoded, fs)
        loud_ok = abs(loudness_lufs - lufs) <= 0.1
        peak_ok = true_peak_dbtp is None or tp <= true_peak_dbtp + 0.05
        if loud_ok and peak_ok:
            break
        offset = lufs - pre_lufs
        if not peak_ok:
            ceiling -= tp - true_peak_dbtp + 0.05
        pre, _, pre_lufs, _ = normalize(audio, fs, loudness_lufs - offset, ceiling)
        decoded = _encode_mp3(path, pre, fs, kbps)
    return integrated_loudness(decoded, fs), measure_tp(decoded, fs)
