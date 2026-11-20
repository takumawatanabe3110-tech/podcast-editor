import { describe, expect, it } from 'vitest'
import { eqFirst, gateBeforeComp, putFx, setOrder } from './EffectsView'

const T = (...types: string[]) => types.map(type => ({ type }))
const types = (fx: { type: string }[]) => fx.map(e => e.type)

describe('エフェクトの並び', () => {
  it('ゲート・コンプはフェーダーより前、ゲート → コンプの順に入る', () => {
    let fx = T('eq', 'gain')
    fx = putFx(fx, { type: 'compressor' })
    expect(types(fx)).toEqual(['eq', 'compressor', 'gain'])
    fx = putFx(fx, { type: 'gate' })
    expect(types(fx)).toEqual(['eq', 'gate', 'compressor', 'gain'])
  })
  it('EQ がなければ、ダイナミクスの前（EQ → ダイナミクス）に入る', () => {
    expect(types(putFx(T('gate', 'compressor', 'gain'), { type: 'eq' }))).toEqual(['eq', 'gate', 'compressor', 'gain'])
  })
  it('リミッターは最後', () => {
    expect(types(putFx(T('compressor', 'gain'), { type: 'limiter' }))).toEqual(['compressor', 'gain', 'limiter'])
  })
  it('あれば置き換える', () => {
    const fx = putFx([{ type: 'eq', a: 1 }, { type: 'gain' }] as never, { type: 'eq', a: 2 } as never) as { a?: number }[]
    expect(fx[0].a).toBe(2)
  })
  it('EQ とダイナミクスの順番を入れ替える', () => {
    const fx = T('eq', 'gate', 'compressor', 'gain')
    const r = setOrder(fx, false)
    expect(types(r)).toEqual(['gate', 'compressor', 'eq', 'gain'])
    expect(eqFirst(r)).toBe(false)
    expect(types(setOrder(r, true))).toEqual(['eq', 'gate', 'compressor', 'gain'])
    // ダイナミクスが後ろのとき、新しい EQ はダイナミクスの後に入る
    expect(types(putFx(T('gate', 'compressor', 'gain'), { type: 'eq' }))).toEqual(['eq', 'gate', 'compressor', 'gain'])
  })
  it('コンプ → ゲートの順はゲート → コンプにそろえる', () => {
    expect(types(gateBeforeComp(T('eq', 'compressor', 'gate', 'gain')))).toEqual(['eq', 'gate', 'compressor', 'gain'])
  })
})
