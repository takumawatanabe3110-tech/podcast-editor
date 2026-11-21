// 時間まわりの計算（純粋関数）。エンジン（project.py / render.py）と同じ結果になるように書く。
// 基準時刻 = 文字起こしの時刻（区間はこの時刻）／ 出力時刻 = 完成エピソードの時刻 / file time = 各素材ファイル内の時刻
import type { BgmClip, Edit, Project, Segment, Sync } from './types'

const segLen = (s: Segment) => s.end - s.start

/** 各区間の出力時刻での開始位置。つなぎ目はクロスフェードの分だけ重ねる */
export function layout(edit: Edit): { outStart: number; start: number; end: number }[] {
  const xf = edit.crossfade_ms / 1000
  const out: { outStart: number; start: number; end: number }[] = []
  let t = edit.position
  edit.segments.forEach((s, i) => {
    if (i > 0) t -= xf
    out.push({ outStart: t, start: s.start, end: s.end })
    t += segLen(s)
  })
  return out
}

/** 出力の終わり（区間がなければ position） */
export function outputEnd(edit: Edit): number {
  const lay = layout(edit)
  if (!lay.length) return edit.position
  const l = lay[lay.length - 1]
  return l.outStart + (l.end - l.start)
}

/** 基準時刻 → 出力時刻。カット済みなら null（半開区間、最初に合ったものを採用） */
export function refToOut(edit: Edit, t: number): number | null {
  for (const l of layout(edit)) {
    if (l.start <= t && t < l.end) return l.outStart + (t - l.start)
  }
  return null
}

/** 出力時刻 → 基準時刻。区間の外なら null */
export function outToRef(edit: Edit, t: number): number | null {
  for (const l of layout(edit)) {
    if (l.outStart <= t && t < l.outStart + (l.end - l.start)) return l.start + (t - l.outStart)
  }
  return null
}

/** 基準時刻 → 各素材ファイル内の時刻（オフセット＋ドリフト）。基準の素材はそのまま */
export function fileTime(sync: Sync, sourceId: string, refT: number): number {
  if (sourceId === sync.reference) return refT
  const tr = sync.tracks[sourceId]
  if (!tr) return refT
  return refT + tr.offset_sec + tr.drift_ppm * 1e-6 * refT
}

export function anchorTime(project: Project, anchor: string): number {
  if (anchor === 'voice_start') return project.edit.position
  if (anchor === 'voice_end') return outputEnd(project.edit)
  if (anchor === 'output_start') return 0
  throw new Error(`未対応の基準: ${anchor}`)
}

/** BGM クリップの出力時刻での開始位置 */
export function bgmStart(project: Project, clip: BgmClip): number {
  return anchorTime(project, clip.anchor) + clip.at
}

/** クリップ先頭からの時刻 t での音量（倍率）。範囲外は 0 */
export function bgmGainAt(clip: BgmClip, t: number): number {
  if (t < 0 || t > clip.duration) return 0
  let db = clip.gain_db
  if (clip.keyframes.length) {
    const kf = [...clip.keyframes].sort((a, b) => a.t - b.t)
    let v: number
    if (t <= kf[0].t) v = kf[0].db
    else if (t >= kf[kf.length - 1].t) v = kf[kf.length - 1].db
    else {
      v = kf[kf.length - 1].db
      for (let i = 0; i < kf.length - 1; i++) {
        const a = kf[i]
        const b = kf[i + 1]
        if (t >= a.t && t <= b.t) {
          v = b.t === a.t ? b.db : a.db + ((b.db - a.db) * (t - a.t)) / (b.t - a.t)
          break
        }
      }
    }
    db += v
  }
  let env = 10 ** (db / 20)
  const clip01 = (x: number) => Math.min(1, Math.max(0, x))
  if (clip.fade_in > 0) env *= 1 - clip01(1 - t / clip.fade_in) ** clip.fade_in_curve
  if (clip.fade_out > 0) env *= 1 - clip01(1 - (clip.duration - t) / clip.fade_out) ** clip.fade_out_curve
  return env
}

/** t0〜t1（両端含む）を 1秒あたり rate 点でサンプルした音量カーブ（setValueCurveAtTime 用） */
export function bgmGainCurve(clip: BgmClip, t0: number, t1: number, rate: number): Float32Array {
  const n = Math.max(2, Math.floor((t1 - t0) * rate) + 1)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / (n - 1)
    out[i] = bgmGainAt(clip, t)
  }
  return out
}

/** 基準時刻 start〜end を取り除く（新しい配列を返す） */
export function cutRange(segments: Segment[], start: number, end: number): Segment[] {
  if (end <= start) throw new Error('カットの終わりは始まりより後にしてください')
  const out: Segment[] = []
  for (const s of segments) {
    if (end <= s.start || start >= s.end) {
      out.push({ ...s })
      continue
    }
    if (s.start < start) out.push({ start: s.start, end: start })
    if (end < s.end) out.push({ start: end, end: s.end })
  }
  return out
}

/** カットを戻す：残す区間と [start,end] の和集合（時間順、重なり・接する区間は結合） */
export function restoreRange(segments: Segment[], start: number, end: number): Segment[] {
  if (end <= start) throw new Error('範囲の終わりは始まりより後にしてください')
  const all = [...segments.map((s) => ({ ...s })), { start, end }].sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  for (const s of all) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end + 1e-6) last.end = Math.max(last.end, s.end)
    else out.push(s)
  }
  return out
}

/** クロスフェードより短い区間はエンジンの検証で弾かれるので落とす */
export function normalizeSegments(segments: Segment[], crossfadeMs: number): Segment[] {
  const min = crossfadeMs / 1000 + 0.001
  return segments.filter((s) => segLen(s) > min).map((s) => ({ ...s }))
}

/** [start,end] のうち区間に覆われている割合（0〜1）。幅ゼロなら start が区間内かで 1/0 */
export function coveredFraction(segments: Segment[], start: number, end: number): number {
  if (end <= start) return segments.some((s) => s.start <= start && start < s.end) ? 1 : 0
  let sum = 0
  for (const s of segments) {
    const o = Math.min(end, s.end) - Math.max(start, s.start)
    if (o > 0) sum += o
  }
  return Math.min(1, sum / (end - start))
}

/** 半分以上カットされていれば true */
export function isCut(segments: Segment[], start: number, end: number): boolean {
  return coveredFraction(segments, start, end) < 0.5
}

export interface VoicePiece {
  when: number // 今から何秒後に鳴らし始めるか
  fileStart: number // 素材ファイルの何秒目から
  duration: number // 出力時間での長さ
  rate: number // 再生速度（ドリフト追従）
  fadeIn: number
  fadeOut: number
  refStart: number // 鳴らし始めの基準時刻（音量カーブ用）
}

/** 1本の声素材について、出力時刻 fromOut から再生するための予定表 */
export function voicePieces(project: Project, sourceId: string, fromOut: number): VoicePiece[] {
  const lay = layout(project.edit)
  const xf = project.edit.crossfade_ms / 1000
  const tr = sourceId === project.sync.reference ? undefined : project.sync.tracks[sourceId]
  const rate = 1 + (tr ? tr.drift_ppm : 0) * 1e-6
  const pieces: VoicePiece[] = []
  lay.forEach((l, i) => {
    const len = l.end - l.start
    if (!(l.outStart + len > fromOut)) return
    const skip = Math.max(0, fromOut - l.outStart)
    let when = Math.max(0, l.outStart - fromOut)
    let duration = len - skip
    let fileStart = fileTime(project.sync, sourceId, l.start + skip)
    let refStart = l.start + skip
    if (duration <= 0) return
    if (fileStart < 0) {
      const d = -fileStart / rate
      when += d
      duration -= d
      refStart += d
      fileStart = 0
      if (duration <= 0) return
    }
    pieces.push({
      when,
      fileStart,
      duration,
      rate,
      fadeIn: i > 0 && skip === 0 ? xf : 0,
      fadeOut: i < lay.length - 1 ? xf : 0,
      refStart,
    })
  })
  return pieces
}

export interface BgmPiece {
  clipIndex: number
  when: number
  offset: number
  duration: number
  clipT0: number
}

/** BGM の再生予定表（出力時刻 fromOut から） */
export function bgmPieces(project: Project, fromOut: number): BgmPiece[] {
  const out: BgmPiece[] = []
  project.bgm.forEach((clip, clipIndex) => {
    const start = bgmStart(project, clip)
    if (start + clip.duration <= fromOut) return
    const clipT0 = Math.max(0, fromOut - start)
    out.push({
      clipIndex,
      when: Math.max(0, start - fromOut),
      offset: clip.offset_in + clipT0,
      duration: clip.duration - clipT0,
      clipT0,
    })
  })
  return out
}

/** "mm:ss.s" 形式（時間は分に含める）。四捨五入してから分・秒に分ける */
export function formatTime(sec: number, digits = 1): string {
  const k = 10 ** digits
  const units = Math.round(Math.abs(sec) * k)
  const whole = Math.floor(units / k)
  const frac = units % k
  const mm = Math.floor(whole / 60)
  const ss = whole % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  const f = digits > 0 ? '.' + String(frac).padStart(digits, '0') : ''
  return `${sec < 0 && units > 0 ? '-' : ''}${p2(mm)}:${p2(ss)}${f}`
}

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/** 目盛りの位置（切りのいい間隔で、最大 maxTicks 個くらい） */
export function rulerTicks(t0: number, t1: number, maxTicks = 10): number[] {
  if (!(t1 > t0)) return []
  let step = TICK_STEPS.find((s) => (t1 - t0) / s <= maxTicks)
  if (step === undefined) {
    step = 600
    while ((t1 - t0) / step > maxTicks) step *= 2
  }
  const out: number[] = []
  const first = Math.ceil(t0 / step - 1e-9)
  for (let i = first; i * step <= t1 + 1e-9; i++) {
    out.push(Math.round(i * step * 1e6) / 1e6 + 0) // +0 で -0 を避ける
  }
  return out
}
