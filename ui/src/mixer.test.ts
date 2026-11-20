import { describe, expect, it } from 'vitest'
import { withFader } from './Mixer'
import { faderDb } from './player'

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
