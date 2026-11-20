import { describe, expect, it } from 'vitest'
import { LimiterCore } from './limiterCore'

const FS = 24000

function run(lim: LimiterCore, x: Float32Array, chunk = 128) {
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i += chunk) {
    const n = Math.min(chunk, x.length - i)
    const out = new Float32Array(n)
    lim.process([x.subarray(i, i + n)], [out])
    y.set(out, i)
  }
  return y
}

describe('LimiterCore', () => {
  it('上限を超えない（急に大きくなる音でも）', () => {
    const x = new Float32Array(FS)
    for (let i = 0; i < x.length; i++) x[i] = (i < FS / 2 ? 0.1 : 3.0) * Math.sin((2 * Math.PI * 440 * i) / FS)
    const y = run(new LimiterCore(FS, { ceiling_db: -1 }), x)
    const ceil = Math.pow(10, -1 / 20)
    expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual(ceil + 1e-6)
  })

  it('大きい音の前に下げ始めるので、切る（ジリジリの元）はほとんど起きない', () => {
    const x = new Float32Array(FS)
    for (let i = 0; i < x.length; i++) x[i] = (i < FS / 2 ? 0.1 : 2.0) * Math.sin((2 * Math.PI * 440 * i) / FS)
    const lim = new LimiterCore(FS, { ceiling_db: -1 })
    const y = run(lim, x)
    const ceil = Math.pow(10, -1 / 20)
    const clipped = y.filter(v => Math.abs(v) >= ceil - 1e-7).length
    expect(clipped / y.length).toBeLessThan(0.002)
  })

  it('上限より小さい音は（遅れるだけで）変えない', () => {
    const x = new Float32Array(4800)
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / FS)
    const lim = new LimiterCore(FS, { ceiling_db: -1 })
    const y = run(lim, x, 97)
    const L = lim.latencySamples
    for (let i = L; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i - L], 6)
  })
})
