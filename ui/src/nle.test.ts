import { describe, expect, it } from 'vitest'
import { addPoint, curveDbAt, cutOutRange, movePoint, pieceAt, pieces, removePiece, setEdge, splitAt } from './nle'
import type { Edit } from './types'

const edit = (segs: [number, number][], position = 0): Edit =>
  ({ position, segments: segs.map(([start, end]) => ({ start, end })), crossfade_ms: 0, end_after_speech_sec: null })

describe('編集ソフト型の操作', () => {
  it('区間は出力時刻で詰めて並ぶ', () => {
    const p = pieces(edit([[0, 10], [20, 30]], 5))
    expect(p.map(x => [x.outStart, x.outEnd])).toEqual([[5, 15], [15, 25]])
    expect(pieceAt(edit([[0, 10], [20, 30]], 5), 16)?.i).toBe(1)
  })

  it('C：再生位置で2つに分ける（音は変わらない）', () => {
    const e = edit([[0, 10], [20, 30]], 5)
    expect(splitAt(e, 17)).toEqual([{ start: 0, end: 10 }, { start: 20, end: 22 }, { start: 22, end: 30 }])
    expect(splitAt(e, 5.01)).toEqual(e.segments) // 端すぎるところでは分けない
  })

  it('選んだ範囲（出力時刻）をカットする。区間をまたいでもよい', () => {
    const e = edit([[0, 10], [20, 30]])
    expect(cutOutRange(e, 8, 12)).toEqual([{ start: 0, end: 8 }, { start: 22, end: 30 }])
    expect(cutOutRange(e, 12, 8)).toEqual([{ start: 0, end: 8 }, { start: 22, end: 30 }])
  })

  it('区間を取り除く', () => {
    expect(removePiece(edit([[0, 10], [20, 30]]), 0)).toEqual([{ start: 20, end: 30 }])
  })

  it('端のドラッグ：広げるとカットが戻る。隣と素材の長さは越えない', () => {
    const s = edit([[0, 10], [20, 30]]).segments
    expect(setEdge(s, 0, 'end', 15, 40)).toEqual([{ start: 0, end: 15 }, { start: 20, end: 30 }])
    expect(setEdge(s, 0, 'end', 25, 40)[0].end).toBe(20) // 後ろの区間の始まりまで
    expect(setEdge(s, 1, 'start', 5, 40)[1].start).toBe(10) // 前の区間の終わりまで
    expect(setEdge(s, 1, 'end', 99, 40)[1].end).toBe(40) // 素材の長さまで
    expect(setEdge(s, 0, 'end', -5, 40)[0].end).toBeCloseTo(0.05) // 最短の長さは残す
  })

  it('音量カーブ：点の間は直線、前後は端の値、点がなければ 0', () => {
    const k = [{ t: 1, db: -60 }, { t: 2, db: 0 }]
    expect(curveDbAt(undefined, 5)).toBe(0)
    expect(curveDbAt(k, 0)).toBe(-60)
    expect(curveDbAt(k, 1.5)).toBeCloseTo(-30)
    expect(curveDbAt(k, 9)).toBe(0)
  })

  it('点を足す・動かす', () => {
    const a = addPoint([{ t: 1, db: 0 }, { t: 3, db: 0 }], 2, -6)
    expect(a.index).toBe(1)
    expect(a.kfs.map(k => k.t)).toEqual([1, 2, 3])
    const m = movePoint(a.kfs, 1, 5, -99)
    expect(m[1]).toEqual({ t: 2.99, db: -60 }) // 隣の点を越えない・下限
  })
})
