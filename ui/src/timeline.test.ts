import { describe, expect, it } from 'vitest'
import {
  anchorTime, bgmGainAt, bgmGainCurve, bgmPieces, bgmStart, coveredFraction, cutRange, fileTime,
  formatTime, isCut, layout, normalizeSegments, outToRef, outputEnd, refToOut, restoreRange,
  rulerTicks, voicePieces,
} from './timeline'
import type { BgmClip, Edit, Project, Segment } from './types'

const edit = (segments: Segment[], position = 0, crossfade_ms = 0): Edit => ({
  position, segments, crossfade_ms, end_after_speech_sec: null,
})

const clip = (o: Partial<BgmClip> = {}): BgmClip => ({
  source: 'bgm', at: 0, duration: 10, offset_in: 0, gain_db: 0,
  fade_in: 0, fade_out: 0, fade_in_curve: 1, fade_out_curve: 1,
  keyframes: [], anchor: 'output_start', ...o,
})

const project = (e: Edit, bgm: BgmClip[] = [], tracks: Project['sync']['tracks'] = {}): Project => ({
  format: 'podproj', version: 1, name: 't', sample_rate: 48000, sources: {},
  sync: { reference: 'a', tracks }, voices: [], edit: e, bgm,
  bgm_effects: [], master_effects: [], output: {}, corrections: {},
})

describe('layout / outputEnd', () => {
  it('位置と1区間の終わり', () => {
    const e = edit([{ start: 0.5, end: 3.5 }], 1, 10)
    expect(layout(e)).toEqual([{ outStart: 1, start: 0.5, end: 3.5 }])
    expect(outputEnd(e)).toBeCloseTo(4.0)
  })
  it('クロスフェードで重ねる', () => {
    const e = edit([{ start: 0, end: 2 }, { start: 5, end: 7 }], 0, 100)
    const l = layout(e)
    expect(l[1].outStart).toBeCloseTo(1.9)
    expect(outputEnd(e)).toBeCloseTo(3.9)
  })
  it('区間なしは position', () => {
    expect(outputEnd(edit([], 2))).toBe(2)
  })
})

describe('refToOut / outToRef', () => {
  const e = edit([{ start: 1, end: 3 }, { start: 5, end: 8 }], 0, 100)
  it('往復できる', () => {
    expect(refToOut(e, 1)).toBeCloseTo(0)
    expect(refToOut(e, 6)).toBeCloseTo(1.9 + 1)
    expect(outToRef(e, 2.9)).toBeCloseTo(6)
    for (const t of [1.5, 2.5, 5.2, 7.9]) expect(outToRef(e, refToOut(e, t)!)).toBeCloseTo(t)
  })
  it('半開区間と範囲外', () => {
    expect(refToOut(e, 3)).toBeNull()
    expect(refToOut(e, 4)).toBeNull()
    expect(outToRef(e, -0.1)).toBeNull()
    expect(outToRef(e, outputEnd(e))).toBeNull()
  })
  it('重なり部分は最初の区間が勝つ', () => {
    expect(outToRef(e, 1.95)).toBeCloseTo(2.95)
  })
})

describe('fileTime', () => {
  const sync = { reference: 'a', tracks: { b: { offset_sec: 0.5, drift_ppm: 100 } } }
  it('基準はそのまま', () => expect(fileTime(sync, 'a', 12)).toBe(12))
  it('オフセット＋ドリフト', () => expect(fileTime(sync, 'b', 100)).toBeCloseTo(100 + 0.5 + 0.01))
  it('トラックなしは 0', () => expect(fileTime(sync, 'c', 7)).toBe(7))
})

describe('anchorTime / bgmStart', () => {
  const p = project(edit([{ start: 0.5, end: 3.5 }], 1, 10))
  it('各 anchor', () => {
    expect(anchorTime(p, 'output_start')).toBe(0)
    expect(anchorTime(p, 'voice_start')).toBe(1)
    expect(anchorTime(p, 'voice_end')).toBeCloseTo(4)
    expect(() => anchorTime(p, 'x')).toThrow()
  })
  it('voice_end で at=-1 は 3.0', () => {
    expect(bgmStart(p, clip({ anchor: 'voice_end', at: -1 }))).toBeCloseTo(3.0)
  })
})

describe('bgmGainAt / bgmGainCurve', () => {
  it('範囲外は 0、素の gain', () => {
    const c = clip({ gain_db: -6 })
    expect(bgmGainAt(c, -0.1)).toBe(0)
    expect(bgmGainAt(c, 10.1)).toBe(0)
    expect(bgmGainAt(c, 5)).toBeCloseTo(10 ** (-6 / 20))
  })
  it('キーフレームは dB で直線補間、端は固定', () => {
    const c = clip({ keyframes: [{ t: 2, db: 0 }, { t: 4, db: -20 }] })
    expect(bgmGainAt(c, 0)).toBeCloseTo(1)
    expect(bgmGainAt(c, 3)).toBeCloseTo(10 ** (-10 / 20))
    expect(bgmGainAt(c, 8)).toBeCloseTo(0.1)
  })
  it('フェードアウト curve 2', () => {
    const c = clip({ duration: 10, fade_out: 4, fade_out_curve: 2, gain_db: -6 })
    const base = 10 ** (-6 / 20)
    expect(bgmGainAt(c, 5)).toBeCloseTo(base)
    expect(bgmGainAt(c, 9)).toBeCloseTo(base * (1 - 0.75 ** 2))
    expect(bgmGainAt(c, 10)).toBeCloseTo(0)
  })
  it('フェードイン', () => {
    const c = clip({ fade_in: 2, fade_in_curve: 1 })
    expect(bgmGainAt(c, 0)).toBeCloseTo(0)
    expect(bgmGainAt(c, 1)).toBeCloseTo(0.5)
    expect(bgmGainAt(c, 3)).toBeCloseTo(1)
  })
  it('カーブの点数と両端', () => {
    const c = clip({ fade_in: 2 })
    const a = bgmGainCurve(c, 0, 2, 10)
    expect(a).toBeInstanceOf(Float32Array)
    expect(a.length).toBe(21)
    expect(a[0]).toBeCloseTo(0)
    expect(a[20]).toBeCloseTo(1)
    expect(bgmGainCurve(c, 1, 1, 10).length).toBe(2)
  })
})

describe('cutRange', () => {
  const segs = [{ start: 0, end: 5 }, { start: 8, end: 12 }]
  it('途中で分割', () => {
    expect(cutRange(segs, 1, 2)).toEqual([{ start: 0, end: 1 }, { start: 2, end: 5 }, { start: 8, end: 12 }])
  })
  it('区間をまたぐ', () => {
    expect(cutRange(segs, 3, 10)).toEqual([{ start: 0, end: 3 }, { start: 10, end: 12 }])
  })
  it('丸ごと消す・触れない・元を変えない', () => {
    expect(cutRange(segs, 7, 13)).toEqual([{ start: 0, end: 5 }])
    expect(cutRange(segs, 5, 8)).toEqual(segs)
    expect(segs).toEqual([{ start: 0, end: 5 }, { start: 8, end: 12 }])
  })
  it('end<=start は例外', () => {
    expect(() => cutRange(segs, 2, 2)).toThrow()
    expect(() => cutRange(segs, 3, 2)).toThrow()
  })
})

describe('restoreRange', () => {
  it('カットを戻すと1区間に', () => {
    const cut = cutRange([{ start: 0, end: 10 }], 3, 6)
    expect(restoreRange(cut, 3, 6)).toEqual([{ start: 0, end: 10 }])
  })
  it('離れていれば別区間、時間順', () => {
    expect(restoreRange([{ start: 0, end: 1 }, { start: 8, end: 9 }], 4, 5))
      .toEqual([{ start: 0, end: 1 }, { start: 4, end: 5 }, { start: 8, end: 9 }])
  })
  it('一部だけ戻すと延びる', () => {
    expect(restoreRange([{ start: 0, end: 1 }, { start: 8, end: 9 }], 0.5, 8.5))
      .toEqual([{ start: 0, end: 9 }])
  })
  it('end<=start は例外', () => {
    expect(() => restoreRange([], 1, 1)).toThrow()
  })
})

describe('normalizeSegments', () => {
  it('短すぎる区間を落とす', () => {
    const r = normalizeSegments([{ start: 0, end: 0.01 }, { start: 1, end: 2 }, { start: 3, end: 3.011 }], 10)
    expect(r).toEqual([{ start: 1, end: 2 }, { start: 3, end: 3.011 }])
  })
  it('ちょうど境界は落とす', () => {
    expect(normalizeSegments([{ start: 0, end: 0.011 }], 10)).toEqual([])
  })
})

describe('coveredFraction / isCut', () => {
  const segs = [{ start: 0, end: 5 }, { start: 8, end: 12 }]
  it('割合', () => {
    expect(coveredFraction(segs, 0, 5)).toBeCloseTo(1)
    expect(coveredFraction(segs, 4, 6)).toBeCloseTo(0.5)
    expect(coveredFraction(segs, 5, 8)).toBe(0)
    expect(coveredFraction(segs, 4, 9)).toBeCloseTo(2 / 5)
  })
  it('幅ゼロ', () => {
    expect(coveredFraction(segs, 2, 2)).toBe(1)
    expect(coveredFraction(segs, 6, 6)).toBe(0)
  })
  it('isCut', () => {
    expect(isCut(segs, 5.5, 7.5)).toBe(true)
    expect(isCut(segs, 1, 2)).toBe(false)
    expect(isCut(segs, 4, 6)).toBe(false) // ちょうど半分は残す扱い
  })
})

describe('voicePieces', () => {
  const e = edit([{ start: 10, end: 14 }, { start: 20, end: 26 }], 0, 100)
  const p = project(e, [], { b: { offset_sec: 1, drift_ppm: 1000 } })
  // layout: 0〜4 / 3.9〜9.9
  it('最初から', () => {
    const r = voicePieces(p, 'a', 0)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ when: 0, fileStart: 10, duration: 4, rate: 1, fadeIn: 0, fadeOut: 0.1 })
    expect(r[1].when).toBeCloseTo(3.9)
    expect(r[1]).toMatchObject({ fileStart: 20, duration: 6, fadeIn: 0.1, fadeOut: 0 })
  })
  it('区間の途中から（フェードインなし）', () => {
    const r = voicePieces(p, 'a', 1)
    expect(r[0]).toMatchObject({ when: 0, fileStart: 11, duration: 3, fadeIn: 0 })
    expect(r[1].when).toBeCloseTo(2.9)
  })
  it('2つ目の途中から、1つ目は出ない', () => {
    const r = voicePieces(p, 'a', 5)
    expect(r).toHaveLength(1)
    expect(r[0].when).toBe(0)
    expect(r[0].fileStart).toBeCloseTo(20 + 1.1)
    expect(r[0].duration).toBeCloseTo(4.9)
    expect(r[0].fadeIn).toBe(0)
  })
  it('終わりを過ぎたら空', () => {
    expect(voicePieces(p, 'a', 9.9)).toEqual([])
  })
  it('ドリフトとオフセット', () => {
    const r = voicePieces(p, 'b', 0)
    expect(r[0].rate).toBeCloseTo(1.001)
    expect(r[0].fileStart).toBeCloseTo(10 + 1 + 0.01)
  })
  it('file time が負なら頭を削る', () => {
    const q = project(edit([{ start: 0, end: 5 }]), [], { b: { offset_sec: -2, drift_ppm: 0 } })
    const r = voicePieces(q, 'b', 0)
    expect(r[0]).toMatchObject({ fileStart: 0, duration: 3 })
    expect(r[0].when).toBeCloseTo(2)
  })
  it('頭を削って残らなければ捨てる', () => {
    const q = project(edit([{ start: 0, end: 1 }]), [], { b: { offset_sec: -2, drift_ppm: 0 } })
    expect(voicePieces(q, 'b', 0)).toEqual([])
  })
})

describe('bgmPieces', () => {
  const p = project(edit([{ start: 0, end: 10 }], 1), [
    clip({ at: 2, duration: 5, offset_in: 3 }), // 出力 2〜7
    clip({ anchor: 'voice_end', at: -1, duration: 4, offset_in: 0 }), // 出力 10〜14
  ])
  it('これから鳴るもの', () => {
    const r = bgmPieces(p, 0)
    expect(r[0]).toMatchObject({ clipIndex: 0, when: 2, offset: 3, duration: 5, clipT0: 0 })
    expect(r[1]).toMatchObject({ clipIndex: 1, when: 10, duration: 4 })
  })
  it('途中から', () => {
    const r = bgmPieces(p, 4)
    expect(r[0]).toMatchObject({ when: 0, clipT0: 2, offset: 5, duration: 3 })
    expect(r[1].when).toBe(6)
  })
  it('終わったクリップは出ない', () => {
    const r = bgmPieces(p, 7)
    expect(r).toHaveLength(1)
    expect(r[0].clipIndex).toBe(1)
  })
})

describe('formatTime', () => {
  it('基本', () => {
    expect(formatTime(337.3)).toBe('05:37.3')
    expect(formatTime(0)).toBe('00:00.0')
    expect(formatTime(3725)).toBe('62:05.0')
  })
  it('負', () => expect(formatTime(-1)).toBe('-00:01.0'))
  it('繰り上がり', () => {
    expect(formatTime(59.96)).toBe('01:00.0')
    expect(formatTime(59.96, 2)).toBe('00:59.96')
    expect(formatTime(5.4, 0)).toBe('00:05')
  })
  it('-0 を出さない', () => expect(formatTime(-0.01)).toBe('00:00.0'))
})

describe('rulerTicks', () => {
  it('切りのいい間隔', () => {
    expect(rulerTicks(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
  it('途中から始まる', () => {
    expect(rulerTicks(3.3, 8, 10)).toEqual([3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8])
  })
  it('個数が上限を超えない', () => {
    for (const [a, b] of [[0, 337], [100, 100.7], [0, 20000]]) {
      const t = rulerTicks(a, b, 10)
      expect(t.length).toBeLessThanOrEqual(11)
      expect(t.length).toBeGreaterThan(0)
      expect(t.every((x) => x >= a && x <= b)).toBe(true)
    }
  })
  it('空の範囲', () => expect(rulerTicks(5, 5)).toEqual([]))
})
