// 台本からのカット・復元と、編集の前後で再生位置を保つための計算。
import { cutRange, layout, normalizeSegments, outputEnd, restoreRange } from './timeline'
import type { Edit, Segment, Utterance } from './types'

/** 基準時刻 t → 出力時刻。カットされていれば、その後で最初に残っている位置 */
export function refToOutOrNext(edit: Edit, t: number): number {
  for (const l of layout(edit)) {
    if (t < l.start) return l.outStart
    if (t < l.end) return l.outStart + (t - l.start)
  }
  return outputEnd(edit)
}

/** 選んだ発言（表示順の番号）を、続いているまとまりごとに [始まり, 終わり] の基準時刻へ */
export function selectionRanges(lines: Utterance[], selected: number[]): [number, number][] {
  const idx = [...new Set(selected)].sort((a, b) => a - b)
  const out: [number, number][] = []
  let run: number[] = []
  const flush = () => {
    if (!run.length) return
    const us = run.map(i => lines[i])
    out.push([Math.min(...us.map(u => u.start)), Math.max(...us.map(u => u.end))])
    run = []
  }
  for (const i of idx) {
    if (run.length && i !== run[run.length - 1] + 1) flush()
    run.push(i)
  }
  flush()
  return out
}

export function cutLines(edit: Edit, lines: Utterance[], selected: number[]): Segment[] {
  let segs = edit.segments
  for (const [a, b] of selectionRanges(lines, selected)) if (b > a) segs = cutRange(segs, a, b)
  return normalizeSegments(segs, edit.crossfade_ms)
}

/**
 * カット済みの発言を戻す。途中のカットなら、そのカット（前後の残す区間のすき間）を丸ごと戻す。
 * 最初の区間より前・最後の区間より後（拍手の前や収録後の雑談）は、その発言のところまでだけ戻す。
 */
export function restoreLine(edit: Edit, u: Utterance): Segment[] {
  const segs = [...edit.segments].sort((a, b) => a.start - b.start)
  const mid = (u.start + u.end) / 2
  let range: [number, number] = [u.start, u.end]
  if (segs.length) {
    if (mid < segs[0].start) range = [u.start, segs[0].start]
    else if (mid >= segs[segs.length - 1].end) range = [segs[segs.length - 1].end, u.end]
    else {
      for (let i = 0; i + 1 < segs.length; i++) {
        if (segs[i].end <= mid && mid < segs[i + 1].start) { range = [segs[i].end, segs[i + 1].start]; break }
      }
    }
  }
  return normalizeSegments(restoreRange(edit.segments, range[0], range[1]), edit.crossfade_ms)
}

/** 台本に出す時刻（フィラーでない最初の言葉） */
export const lineTime = (u: Utterance) => u.words.find(w => !w.filler)?.t0 ?? u.start
