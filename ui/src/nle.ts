// 編集画面（完成版の時刻の軸）での操作の計算。カットした部分は詰めて見せる（一般的な編集ソフトと同じ）。
// 区間（edit.segments）は基準時刻で持つ。画面の位置（出力時刻）との変換は layout を使う。
import { layout, normalizeSegments, cutRange } from './timeline'
import type { Edit, Keyframe, Segment } from './types'

const MIN_LEN = 0.05 // 区間の最短（秒）

export interface Piece { i: number; outStart: number; outEnd: number; start: number; end: number }

/** 画面に並ぶ区間（出力時刻での位置つき） */
export function pieces(edit: Edit): Piece[] {
  return layout(edit).map((l, i) => ({ i, outStart: l.outStart, outEnd: l.outStart + (l.end - l.start), start: l.start, end: l.end }))
}

/** 出力時刻 t にある区間（つなぎ目の重なりでは後ろの区間） */
export function pieceAt(edit: Edit, t: number): Piece | null {
  let hit: Piece | null = null
  for (const p of pieces(edit)) if (t >= p.outStart && t < p.outEnd) hit = p
  return hit
}

/** C キー：出力時刻 t で区間を2つに分ける（切れ目を入れるだけ。音は変わらない） */
export function splitAt(edit: Edit, t: number): Segment[] {
  const p = pieceAt(edit, t)
  if (!p) return edit.segments
  const r = p.start + (t - p.outStart)
  if (r - p.start < MIN_LEN || p.end - r < MIN_LEN) return edit.segments
  const segs = [...edit.segments]
  segs.splice(p.i, 1, { start: p.start, end: r }, { start: r, end: p.end })
  return segs
}

/** 出力時刻 a〜b（波形の上で選んだ範囲）をカットする */
export function cutOutRange(edit: Edit, a: number, b: number): Segment[] {
  if (b < a) [a, b] = [b, a]
  let segs = edit.segments
  for (const p of pieces(edit)) {
    const x = Math.max(a, p.outStart), y = Math.min(b, p.outEnd)
    if (y - x <= 0.001) continue
    segs = cutRange(segs, p.start + (x - p.outStart), p.start + (y - p.outStart))
  }
  return normalizeSegments(segs, edit.crossfade_ms)
}

/** i 番目の区間を取り除く */
export function removePiece(edit: Edit, i: number): Segment[] {
  return edit.segments.filter((_, k) => k !== i)
}

/**
 * 区間の端を動かす（端のドラッグ）。広げるとカットした部分が戻る。
 * 隣の区間とは重ならない（基準時刻で、前の区間の終わり〜後ろの区間の始まりの間）。素材の長さ refDur も越えない。
 */
export function setEdge(segments: Segment[], i: number, side: 'start' | 'end', value: number, refDur: number): Segment[] {
  const s = segments[i]
  if (!s) return segments
  const prev = segments[i - 1], next = segments[i + 1]
  // 並べ替えのない普通の並び（時刻順）のときだけ、隣を越えないようにする
  const lo = prev && prev.end <= s.start ? prev.end : 0
  const hi = next && next.start >= s.end ? next.start : refDur
  const v = side === 'start'
    ? Math.min(Math.max(value, lo), s.end - MIN_LEN)
    : Math.max(Math.min(value, hi), s.start + MIN_LEN)
  return segments.map((x, k) => (k === i ? { ...x, [side]: v } : x))
}

/** 声の音量カーブ（基準時刻の点）の、時刻 r での値（dB）。点の間は直線、前後は端の値のまま。点がなければ 0 */
export function curveDbAt(kfs: Keyframe[] | undefined, r: number): number {
  if (!kfs || !kfs.length) return 0
  const k = [...kfs].sort((a, b) => a.t - b.t)
  if (r <= k[0].t) return k[0].db
  if (r >= k[k.length - 1].t) return k[k.length - 1].db
  for (let i = 0; i + 1 < k.length; i++) {
    if (r <= k[i + 1].t) {
      const u = (r - k[i].t) / (k[i + 1].t - k[i].t || 1)
      return k[i].db + u * (k[i + 1].db - k[i].db)
    }
  }
  return k[k.length - 1].db
}

/** 点を足す（同じ時刻の点があれば置き換える）。時刻順に並べ、足した点の番号を返す */
export function addPoint(kfs: Keyframe[] | undefined, t: number, db: number): { kfs: Keyframe[]; index: number } {
  const list = (kfs ?? []).filter(k => Math.abs(k.t - t) > 1e-3)
  list.push({ t, db })
  list.sort((a, b) => a.t - b.t)
  return { kfs: list, index: list.findIndex(k => k.t === t && k.db === db) }
}

/** i 番目の点を動かす（隣の点は越えない） */
export function movePoint(kfs: Keyframe[], i: number, t: number, db: number, dbMin = -60, dbMax = 12): Keyframe[] {
  const lo = i > 0 ? kfs[i - 1].t + 0.01 : -Infinity
  const hi = i < kfs.length - 1 ? kfs[i + 1].t - 0.01 : Infinity
  const nt = Math.min(Math.max(t, lo), hi)
  const nd = Math.min(Math.max(db, dbMin), dbMax)
  return kfs.map((k, j) => (j === i ? { t: +nt.toFixed(4), db: +nd.toFixed(1) } : k))
}
