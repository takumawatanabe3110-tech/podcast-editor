import { describe, expect, it } from 'vitest'
import { cutLines, refToOutOrNext, restoreLine, selectionRanges } from './editops'
import type { Edit, Utterance } from './types'

const u = (start: number, end: number): Utterance => ({ speaker: 'A', source: 'a', start, end, text: '', script: 'x', words: [] })
const edit = (segments: [number, number][]): Edit =>
  ({ position: 1, segments: segments.map(([start, end]) => ({ start, end })), crossfade_ms: 10, end_after_speech_sec: null })

describe('editops', () => {
  const lines = [u(1, 2), u(2.5, 3), u(3.2, 4), u(6, 7)]

  it('続いた選択は1つの範囲にまとめる', () => {
    expect(selectionRanges(lines, [2, 0, 1, 3])).toEqual([[1, 7]])
    expect(selectionRanges(lines, [0, 1, 3])).toEqual([[1, 3], [6, 7]])
    expect(selectionRanges(lines, [0, 2])).toEqual([[1, 2], [3.2, 4]])
  })

  it('選んだ文をカットし、クリックで丸ごと戻す', () => {
    const e = edit([[0, 10]])
    const cut = cutLines(e, lines, [1, 2])
    expect(cut).toEqual([{ start: 0, end: 2.5 }, { start: 4, end: 10 }])
    expect(restoreLine({ ...e, segments: cut }, lines[2])).toEqual([{ start: 0, end: 10 }])
  })

  it('最初の区間より前の発言は、その発言のところまでだけ戻す', () => {
    const e = edit([[5, 10]])
    expect(restoreLine(e, u(2, 3))).toEqual([{ start: 2, end: 10 }])
    expect(restoreLine(e, u(12, 13))).toEqual([{ start: 5, end: 13 }])
  })

  it('カットされた位置は次に残っている位置へ', () => {
    const e = edit([[0, 2], [4, 6]])
    expect(refToOutOrNext(e, 1)).toBeCloseTo(2)
    expect(refToOutOrNext(e, 3)).toBeCloseTo(1 + 2 - 0.01)
    expect(refToOutOrNext(e, 99)).toBeCloseTo(1 + 4 - 0.01)
  })
})
