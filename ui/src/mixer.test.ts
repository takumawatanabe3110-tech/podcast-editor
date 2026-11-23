import { describe, expect, it } from 'vitest'
import { withFader } from './Mixer'
import { faderDb, previewTrimDb } from './player'
import type { Project } from './types'

describe('withFader', () => {
  it('フェーダーがなければ最後に足す', () => {
    const eq = { type: 'eq', bands: [] }
    expect(withFader([eq], 3)).toEqual([eq, { type: 'gain', db: 3 }])
  })
  it('あれば最後のフェーダーを変えて合計をそろえる（他のエフェクトはそのまま）', () => {
    const fx = [{ type: 'gain', db: 2 }, { type: 'eq', bands: [] }, { type: 'gain', db: 5 }]
    const out = withFader(fx, -1.5)
    expect(faderDb(out)).toBeCloseTo(-1.5)
    expect(out[0]).toBe(fx[0])
    expect(out[1]).toBe(fx[1])
    expect(fx[2]).toEqual({ type: 'gain', db: 5 }) // 元は変えない
  })
})

describe('previewTrimDb', () => {
  const p = (lufs: number | null) => ({
    voices: [{ effects: [{ type: 'gain', db: 5 }] }, { effects: [{ type: 'gain', db: 5 }] }],
    master_effects: [{ type: 'gain', db: 7.8 }],
    output: { loudness_lufs: lufs },
  }) as unknown as Project
  it('書き出しで測った値があれば、完成版と同じ大きさになる補正', () => {
    // 12/04 の実測：そろえる前 −8.23 LUFS（フェーダー 5＋7.8 を除くと −21.03）→ 書き出しで −5.77 dB
    expect(previewTrimDb(p(-14), -21.03)).toBeCloseTo(-5.77, 2)
  })
  it('測った値がなければ見積もり（実測の平均 −20.2）で合わせる', () => {
    expect(previewTrimDb(p(-14), null)).toBeCloseTo(-6.6, 5)
  })
  it('そろえない設定なら補正しない', () => {
    expect(previewTrimDb(p(null), -21.03)).toBe(0)
  })
})
