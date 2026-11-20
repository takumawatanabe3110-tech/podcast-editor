// BGM クリップの編集操作（純粋関数）。すべて新しいオブジェクトを返し、元は変えない。
import type { BgmAnchor, BgmClip, Keyframe, Project } from './types'
import { anchorTime, bgmGainAt, bgmStart } from './timeline'

export const MIN_DURATION = 0.1 // クリップの最短（秒）
export const MIN_KF_GAP = 0.01 // キーフレーム間の最小間隔（秒）
const DB_MIN = -60
const DB_MAX = 12

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** クリップの出力時刻での開始 */
export function clipStart(project: Project, clip: BgmClip): number {
  return bgmStart(project, clip)
}

/** クリップの出力時刻での終わり */
export function clipEnd(project: Project, clip: BgmClip): number {
  return bgmStart(project, clip) + clip.duration
}

/** 基準を変える。出力上の開始位置は変えない（at を計算し直す） */
export function setAnchor(project: Project, clip: BgmClip, anchor: BgmAnchor): BgmClip {
  const start = bgmStart(project, clip)
  return { ...clip, anchor, at: start - anchorTime(project, anchor) }
}

/** フェードの合計が長さを超えないようにする（先にフェードアウト、次にフェードイン） */
function fitFades(clip: BgmClip): BgmClip {
  let { fade_in, fade_out } = clip
  if (fade_in + fade_out > clip.duration) {
    fade_out = Math.max(0, clip.duration - fade_in)
    if (fade_in > clip.duration) fade_in = clip.duration
  }
  return { ...clip, fade_in, fade_out }
}

/** 開始側をドラッグ。keepEnd（既定）は頭を削る/伸ばす、false はクリップ全体をずらす */
export function moveStart(
  project: Project,
  clip: BgmClip,
  newOutStart: number,
  opts: { keepEnd?: boolean; fileDuration?: number } = {},
): BgmClip {
  const start = bgmStart(project, clip)
  let delta = newOutStart - start
  if (opts.keepEnd === false) {
    return { ...clip, at: clip.at + delta, keyframes: clip.keyframes.map((k) => ({ ...k })) }
  }
  delta = Math.max(delta, -clip.offset_in) // offset_in は 0 未満にしない
  delta = Math.min(delta, clip.duration - MIN_DURATION) // 最短 0.1 秒
  return fitFades({
    ...clip,
    at: clip.at + delta,
    offset_in: clip.offset_in + delta,
    duration: clip.duration - delta,
    keyframes: clip.keyframes.map((k) => ({ t: k.t - delta, db: k.db })),
  })
}

/** 終わり側（カット位置）をドラッグ。長さだけ変わる */
export function moveEnd(project: Project, clip: BgmClip, newOutEnd: number, fileDuration?: number): BgmClip {
  let d = newOutEnd - bgmStart(project, clip)
  if (fileDuration !== undefined) d = Math.min(d, fileDuration - clip.offset_in)
  d = Math.max(MIN_DURATION, d)
  return fitFades({ ...clip, duration: d, keyframes: clip.keyframes.map((k) => ({ ...k })) })
}

/** フェード秒数を設定。0〜（長さ − 反対側のフェード）に収める */
export function setFade(clip: BgmClip, which: 'in' | 'out', seconds: number): BgmClip {
  const other = which === 'in' ? clip.fade_out : clip.fade_in
  const v = clamp(seconds, 0, Math.max(0, clip.duration - other))
  return which === 'in' ? { ...clip, fade_in: v } : { ...clip, fade_out: v }
}

/** キーフレームだけの音量カーブ（dB）。範囲外は端の値で一定、なければ 0 */
export function keyframeDbAt(clip: BgmClip, t: number): number {
  const kf = [...clip.keyframes].sort((a, b) => a.t - b.t)
  if (!kf.length) return 0
  if (t <= kf[0].t) return kf[0].db
  const last = kf[kf.length - 1]
  if (t >= last.t) return last.db
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i]
    const b = kf[i + 1]
    if (t >= a.t && t <= b.t) return b.t === a.t ? b.db : a.db + ((b.db - a.db) * (t - a.t)) / (b.t - a.t)
  }
  return last.db
}

/** キーフレームを追加（t 順を保つ）。db 省略時はその位置のカーブ値 */
export function addKeyframe(clip: BgmClip, t: number, db?: number): BgmClip {
  const tt = clamp(t, 0, clip.duration)
  const v = db ?? keyframeDbAt(clip, tt)
  const kf: Keyframe[] = [...clip.keyframes.map((k) => ({ ...k })), { t: tt, db: v }]
  kf.sort((a, b) => a.t - b.t)
  return { ...clip, keyframes: kf }
}

/** キーフレームを動かす。t は両隣（0.01 秒以上あける）と [0, duration] に収め、db は −60〜+12 */
export function moveKeyframe(
  clip: BgmClip,
  index: number,
  t: number,
  db: number,
): { clip: BgmClip; index: number } {
  const kf = clip.keyframes
  if (index < 0 || index >= kf.length) return { clip, index }
  const lo = index > 0 ? Math.max(0, kf[index - 1].t + MIN_KF_GAP) : 0
  const hi = index < kf.length - 1 ? Math.min(clip.duration, kf[index + 1].t - MIN_KF_GAP) : clip.duration
  const next = kf.map((k, i) =>
    i === index ? { t: Math.min(hi, Math.max(lo, t)), db: clamp(db, DB_MIN, DB_MAX) } : { ...k },
  )
  return { clip: { ...clip, keyframes: next }, index }
}

/** キーフレームを削除 */
export function removeKeyframe(clip: BgmClip, index: number): BgmClip {
  return { ...clip, keyframes: clip.keyframes.filter((_, i) => i !== index).map((k) => ({ ...k })) }
}

/** クリップ時刻 t での合計ゲイン（dB）。gain_db・キーフレーム・フェード込み、下限 −80 */
export function clipGainDb(clip: BgmClip, t: number): number {
  const g = bgmGainAt(clip, t)
  return g > 0 ? Math.max(-80, 20 * Math.log10(g)) : -80
}

/** OP（出力開始が最も早い）／ED（最も遅い）のクリップ番号。なければ −1。1本だけなら OP のみ */
export function findClip(project: Project, kind: 'op' | 'ed'): number {
  const n = project.bgm.length
  if (n === 0 || (kind === 'ed' && n === 1)) return -1
  let best = 0
  let bestT = bgmStart(project, project.bgm[0])
  for (let i = 1; i < n; i++) {
    const s = bgmStart(project, project.bgm[i])
    if (kind === 'op' ? s < bestT : s > bestT) {
      best = i
      bestT = s
    }
  }
  return best
}

/** "+0.9 dB" / "−14.5 dB"（U+2212）/ "0.0 dB" */
export function formatDb(db: number): string {
  const r = Math.round(db * 10) / 10
  if (r === 0) return '0.0 dB'
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)} dB`
}
