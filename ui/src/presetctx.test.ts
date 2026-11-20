import raw from '../../presets/okadayama.json?raw'
import { describe, expect, it } from 'vitest'
import { eqTemplates } from './presetctx'

describe('eqTemplates', () => {
  it('いつもの設定から、声ごと・ゲスト・BGM・マスターの EQ を取り出す（EQ がないものは出さない）', () => {
    const p = JSON.parse(raw)
    const t = eqTemplates(p)
    expect(t.map(x => x.label)).toEqual(['青木さん', '内田さん']) // ゲスト・BGM・マスターには EQ がない
    expect((t[0].bands[0] as { type: string; freq: number })).toEqual({ type: 'highpass', freq: 104 })
  })
  it('プリセットがなければ空', () => {
    expect(eqTemplates(null)).toEqual([])
  })
})
