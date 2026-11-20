import { describe, expect, it } from 'vitest'
import type { BgmClip, Project } from './types'
import { anchorTime } from './timeline'
import {
  addKeyframe, clipEnd, clipGainDb, clipStart, findClip, formatDb, keyframeDbAt,
  moveEnd, moveKeyframe, moveStart, removeKeyframe, setAnchor, setFade,
} from './bgmops'

const mkClip = (o: Partial<BgmClip> = {}): BgmClip => ({
  source: 'bgm', at: 2, duration: 20, offset_in: 5, gain_db: -10,
  fade_in: 0, fade_out: 0, fade_in_curve: 1, fade_out_curve: 1,
  keyframes: [], anchor: 'voice_start', ...o,
})

const mkProject = (bgm: BgmClip[]): Project => ({
  format: 'podproj', version: 1, name: 't', sample_rate: 48000,
  sources: {}, sync: { reference: 'v', tracks: {} }, voices: [],
  edit: { position: 3, segments: [{ start: 0, end: 10 }, { start: 20, end: 30 }], crossfade_ms: 0, end_after_speech_sec: null },
  bgm, bgm_effects: [], master_effects: [], output: {}, corrections: {},
})

describe('clipStart / clipEnd', () => {
  it('基準＋at から開始と終わりを出す', () => {
    const c = mkClip()
    const p = mkProject([c])
    expect(clipStart(p, c)).toBe(5) // position 3 + at 2
    expect(clipEnd(p, c)).toBe(25)
  })
})

describe('setAnchor', () => {
  it('どの基準へ変えても開始位置が変わらない', () => {
    const anchors = ['voice_start', 'voice_end', 'output_start'] as const
    for (const from of anchors) {
      for (const to of anchors) {
        const c = mkClip({ anchor: from, at: -1.5 })
        const p = mkProject([c])
        const c2 = setAnchor(p, c, to)
        expect(c2.anchor).toBe(to)
        expect(clipStart(p, c2)).toBeCloseTo(clipStart(p, c), 9)
        expect(c2.at).toBeCloseTo(clipStart(p, c) - anchorTime(p, to), 9)
        const back = setAnchor(p, c2, from)
        expect(back.at).toBeCloseTo(c.at, 9)
      }
    }
  })
  it('元のクリップは変わらない', () => {
    const c = mkClip()
    setAnchor(mkProject([c]), c, 'output_start')
    expect(c.anchor).toBe('voice_start')
  })
})

describe('moveStart', () => {
  const kfs = [{ t: 4, db: -3 }, { t: 10, db: 0 }]
  it('keepEnd: 終わりと各キーフレームの出力時刻が変わらない', () => {
    const c = mkClip({ keyframes: kfs })
    const p = mkProject([c])
    const c2 = moveStart(p, c, 8) // start 5 -> 8, delta 3
    expect(clipStart(p, c2)).toBeCloseTo(8)
    expect(clipEnd(p, c2)).toBeCloseTo(clipEnd(p, c))
    expect(c2.offset_in).toBeCloseTo(8)
    expect(c2.duration).toBeCloseTo(17)
    c.keyframes.forEach((k, i) => {
      expect(clipStart(p, c2) + c2.keyframes[i].t).toBeCloseTo(clipStart(p, c) + k.t)
      expect(c2.keyframes[i].db).toBe(k.db)
    })
  })
  it('keepEnd: offset_in 0 で左へのドラッグが止まる', () => {
    const c = mkClip({ offset_in: 2 })
    const p = mkProject([c])
    const c2 = moveStart(p, c, 0) // delta -5 だが offset_in は 2 しかない
    expect(c2.offset_in).toBe(0)
    expect(clipStart(p, c2)).toBeCloseTo(3)
    expect(clipEnd(p, c2)).toBeCloseTo(clipEnd(p, c))
    expect(c2.duration).toBeCloseTo(22)
  })
  it('keepEnd: 最短 0.1 秒', () => {
    const c = mkClip()
    const p = mkProject([c])
    const c2 = moveStart(p, c, 100)
    expect(c2.duration).toBeCloseTo(0.1)
    expect(clipEnd(p, c2)).toBeCloseTo(clipEnd(p, c))
  })
  it('keepEnd: フェードが長さを超えたら縮む', () => {
    const c = mkClip({ fade_in: 5, fade_out: 10, duration: 20 })
    const p = mkProject([c])
    const c2 = moveStart(p, c, 5 + 12) // duration 8
    expect(c2.fade_in + c2.fade_out).toBeLessThanOrEqual(c2.duration + 1e-9)
    expect(c2.fade_in).toBe(5)
    expect(c2.fade_out).toBeCloseTo(3)
  })
  it('keepEnd false: 全体をずらすだけ', () => {
    const c = mkClip({ keyframes: kfs })
    const p = mkProject([c])
    const c2 = moveStart(p, c, 9, { keepEnd: false })
    expect(clipStart(p, c2)).toBeCloseTo(9)
    expect(c2.duration).toBe(c.duration)
    expect(c2.offset_in).toBe(c.offset_in)
    expect(c2.keyframes).toEqual(c.keyframes)
  })
})

describe('moveEnd', () => {
  it('長さだけ変わる', () => {
    const c = mkClip()
    const p = mkProject([c])
    const c2 = moveEnd(p, c, 15) // start 5 -> duration 10
    expect(c2.duration).toBeCloseTo(10)
    expect(c2.offset_in).toBe(c.offset_in)
    expect(c2.at).toBe(c.at)
  })
  it('最短 0.1 と fileDuration − offset_in に収める', () => {
    const c = mkClip()
    const p = mkProject([c])
    expect(moveEnd(p, c, 0).duration).toBeCloseTo(0.1)
    expect(moveEnd(p, c, 1000, 30).duration).toBeCloseTo(25)
  })
  it('フェードはアウト→インの順に縮む', () => {
    const c = mkClip({ fade_in: 4, fade_out: 8 })
    const p = mkProject([c])
    const a = moveEnd(p, c, 5 + 9) // duration 9
    expect(a.fade_in).toBe(4)
    expect(a.fade_out).toBeCloseTo(5)
    const b = moveEnd(p, c, 5 + 2) // duration 2
    expect(b.fade_out).toBe(0)
    expect(b.fade_in).toBeCloseTo(2)
  })
})

describe('setFade', () => {
  it('0〜(長さ−反対側) に収める', () => {
    const c = mkClip({ duration: 10, fade_out: 3 })
    expect(setFade(c, 'in', 50).fade_in).toBe(7)
    expect(setFade(c, 'in', -1).fade_in).toBe(0)
    expect(setFade(c, 'out', 4).fade_out).toBe(4)
    expect(c.fade_in).toBe(0)
  })
})

describe('キーフレーム', () => {
  const ramp = mkClip({ duration: 10, keyframes: [{ t: 0, db: -20 }, { t: 10, db: 0 }] })
  it('keyframeDbAt: 補間・端で一定・なしは 0', () => {
    expect(keyframeDbAt(ramp, 5)).toBeCloseTo(-10)
    expect(keyframeDbAt(ramp, -3)).toBe(-20)
    expect(keyframeDbAt(ramp, 99)).toBe(0)
    expect(keyframeDbAt(mkClip(), 3)).toBe(0)
  })
  it('addKeyframe: db 省略はカーブ上の値、gain_db は含めない', () => {
    const c = addKeyframe(ramp, 2.5)
    expect(c.keyframes).toHaveLength(3)
    expect(c.keyframes[1].t).toBe(2.5)
    expect(c.keyframes[1].db).toBeCloseTo(-15)
  })
  it('addKeyframe: 並び順を保ち、t を範囲内に収める', () => {
    let c = addKeyframe(ramp, 7, -5)
    c = addKeyframe(c, 3, -8)
    c = addKeyframe(c, 99, 0)
    c = addKeyframe(c, -4, 0)
    const ts = c.keyframes.map((k) => k.t)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    expect(ts[0]).toBe(0)
    expect(ts[ts.length - 1]).toBe(10)
    expect(ramp.keyframes).toHaveLength(2)
  })
  it('addKeyframe: キーフレームなしなら 0 dB', () => {
    expect(addKeyframe(mkClip(), 1).keyframes[0].db).toBe(0)
  })
  it('moveKeyframe: 両隣の間に収める', () => {
    const c = mkClip({ duration: 10, keyframes: [{ t: 1, db: 0 }, { t: 4, db: 0 }, { t: 8, db: 0 }] })
    const a = moveKeyframe(c, 1, 100, -5)
    expect(a.index).toBe(1)
    expect(a.clip.keyframes[1].t).toBeCloseTo(8 - 0.01)
    expect(a.clip.keyframes[1].db).toBe(-5)
    const b = moveKeyframe(c, 1, -100, 0)
    expect(b.clip.keyframes[1].t).toBeCloseTo(1.01)
    const first = moveKeyframe(c, 0, -3, 0)
    expect(first.clip.keyframes[0].t).toBe(0)
    const last = moveKeyframe(c, 2, 50, 0)
    expect(last.clip.keyframes[2].t).toBe(10)
  })
  it('moveKeyframe: db を −60〜+12 に収める', () => {
    const c = mkClip({ keyframes: [{ t: 1, db: 0 }] })
    expect(moveKeyframe(c, 0, 1, -99).clip.keyframes[0].db).toBe(-60)
    expect(moveKeyframe(c, 0, 1, 99).clip.keyframes[0].db).toBe(12)
    expect(c.keyframes[0].db).toBe(0)
  })
  it('removeKeyframe', () => {
    const c = removeKeyframe(ramp, 0)
    expect(c.keyframes).toEqual([{ t: 10, db: 0 }])
    expect(ramp.keyframes).toHaveLength(2)
  })
})

describe('clipGainDb', () => {
  it('gain_db とキーフレームの合計', () => {
    const c = mkClip({ gain_db: -6, duration: 10, keyframes: [{ t: 0, db: 0 }, { t: 10, db: -10 }] })
    expect(clipGainDb(c, 5)).toBeCloseTo(-11)
  })
  it('フェードの頭は −80 に張り付く', () => {
    const c = mkClip({ fade_in: 2 })
    expect(clipGainDb(c, 0)).toBe(-80)
    expect(clipGainDb(c, -1)).toBe(-80)
    expect(clipGainDb(c, 10)).toBeCloseTo(-10)
  })
})

describe('findClip', () => {
  it('OP は最も早い開始、ED は最も遅い開始', () => {
    const p = mkProject([
      mkClip({ anchor: 'output_start', at: 20 }),
      mkClip({ anchor: 'output_start', at: 0 }),
      mkClip({ anchor: 'voice_end', at: 5 }),
    ])
    expect(findClip(p, 'op')).toBe(1)
    expect(findClip(p, 'ed')).toBe(2)
  })
  it('なし・1本だけ', () => {
    expect(findClip(mkProject([]), 'op')).toBe(-1)
    expect(findClip(mkProject([]), 'ed')).toBe(-1)
    const one = mkProject([mkClip()])
    expect(findClip(one, 'op')).toBe(0)
    expect(findClip(one, 'ed')).toBe(-1)
  })
})

describe('formatDb', () => {
  it('符号つきで表示', () => {
    expect(formatDb(0.94)).toBe('+0.9 dB')
    expect(formatDb(-14.5)).toBe('−14.5 dB')
    expect(formatDb(0)).toBe('0.0 dB')
    expect(formatDb(-0.01)).toBe('0.0 dB')
  })
})
