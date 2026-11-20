import { describe, expect, it } from 'vitest'
import ref from './__fixtures__/dynamics_reference.json'
import { CompressorCore, GateCore } from './dynamicsCore'

const input = Float32Array.from(ref.input, (v) => v / ref.inputScale)
const N = input.length

// チャンク長を変えて流し、全体の出力を返す
function stream(core: { process(i: Float32Array[], o: Float32Array[]): void }, chunk: number): Float32Array {
  const out = new Float32Array(N)
  for (let s = 0; s < N; s += chunk) {
    const e = Math.min(N, s + chunk)
    const o = [new Float32Array(e - s)]
    core.process([input.subarray(s, e)], o)
    out.set(o[0], s)
  }
  return out
}

// エンジン出力を latency だけ遅らせたものと比べる（最後の端数ブロックは比べない）
function maxDiff(out: Float32Array, expected: number[], scale: number, latency: number): number {
  let m = 0
  for (let n = latency; n < N; n++) m = Math.max(m, Math.abs(out[n] - expected[n - latency] / scale))
  return m
}

describe('CompressorCore はエンジンと同じ', () => {
  for (const chunk of [128, 97]) {
    it(`チャンク ${chunk}`, () => {
      const core = new CompressorCore(ref.fs, ref.compressor.params)
      expect(core.latencySamples).toBe(ref.block)
      const out = stream(core, chunk)
      expect(maxDiff(out, ref.compressor.output, ref.outputScale, core.latencySamples)).toBeLessThan(1e-5)
    })
  }
  it('setParams で状態が消えない／メーターが動く', () => {
    const core = new CompressorCore(ref.fs, ref.compressor.params)
    const o = [new Float32Array(128)]
    core.process([input.subarray(2400, 2528)], o)
    const g = core.lastGainDb
    expect(g).toBeLessThan(0)
    core.setParams({ ...ref.compressor.params, ratio: 2 })
    expect(core.lastGainDb).toBe(g)
    expect(core.lastInDb).toBeGreaterThan(-20)
  })
  it('ステレオは共通の音量', () => {
    const core = new CompressorCore(ref.fs, ref.compressor.params)
    const a = input.subarray(2400, 2528)
    const o = [new Float32Array(128), new Float32Array(128)]
    core.process([a, a.map((v) => v * 0.1)], o)
    expect(o[1][100]).toBeCloseTo(o[0][100] * 0.1, 6)
  })
})

const gate = (ref as { gate?: { params: any; output: number[] } }).gate
describe('GateCore はエンジンと同じ', () => {
  const t = gate ? it : it.skip
  for (const chunk of [128, 97]) {
    t(`チャンク ${chunk}`, () => {
      const core = new GateCore(ref.fs, gate!.params)
      const out = stream(core, chunk)
      expect(maxDiff(out, gate!.output, ref.outputScale, core.latencySamples)).toBeLessThan(1e-5)
    })
  }
  if (!gate) it.skip('ゲートの基準データなし：engine の effects._FACTORIES に gate が無い状態で生成されたため', () => {})
})
