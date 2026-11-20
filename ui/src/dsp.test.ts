import { describe, expect, it } from 'vitest'
import ref from './__fixtures__/dynamics_reference.json'
import {
  type EqBand,
  biquadCoefs,
  compStaticGainDb,
  eqResponseDb,
  gateStaticGainDb,
  logFreqs,
  magnitudeDb,
  webAudioBiquad,
} from './dsp'

const FS = ref.fs

describe('EQ はエンジン（scipy）と同じ', () => {
  for (const item of ref.eq) {
    it(`${item.band.type} ${item.band.freq}`, () => {
      const c = biquadCoefs(item.band as EqBand, FS)!
      expect(c).not.toBeNull()
      item.freqs.forEach((f, i) => {
        expect(Math.abs(magnitudeDb(c, f, FS) - item.db[i])).toBeLessThan(0.01)
      })
    })
  }
})

describe('バンドを飛ばす条件', () => {
  it('無効・0dB・ナイキスト以上は null / 0', () => {
    expect(biquadCoefs({ type: 'bell', freq: 1000, gain_db: 0 }, FS)).toBeNull()
    expect(biquadCoefs({ type: 'bell', freq: 1000, gain_db: 3, enabled: false }, FS)).toBeNull()
    expect(biquadCoefs({ type: 'lowpass', freq: 12000 }, FS)).toBeNull()
    expect(webAudioBiquad({ type: 'lowpass', freq: 12000 }, FS)).toBeNull()
    const r = eqResponseDb([{ type: 'bell', freq: 1000, gain_db: 6 }, { type: 'bell', freq: 1000, gain_db: 6, enabled: false }], FS, [1000])
    expect(r.perBand[1]).toEqual([0])
    expect(r.total[0]).toBeCloseTo(6, 6)
  })
  it('logFreqs', () => {
    const f = logFreqs(5)
    expect(f[0]).toBeCloseTo(20)
    expect(f[4]).toBeCloseTo(20000)
  })
})

describe('静的カーブ', () => {
  it('コンプ：しきい値以下は 0、上は傾き、ニー中央', () => {
    expect(compStaticGainDb(-30, -20, 4, 0)).toBe(0)
    expect(compStaticGainDb(-10, -20, 4, 0)).toBeCloseTo(-7.5)
    // knee 100 → 20dB 幅。しきい値ちょうどで slope*(10)^2/(40)
    expect(compStaticGainDb(-20, -20, 4, 100)).toBeCloseTo((-0.75 * 100) / 40)
  })
  it('ゲート', () => {
    expect(gateStaticGainDb(-20, -30, 20)).toBe(0)
    expect(gateStaticGainDb(-40, -30, 20)).toBe(-20)
  })
})

// Web Audio 仕様の BiquadFilterNode の式（正規化前）
function webAudioSpec(type: string, f: number, Q: number, G: number, fs: number) {
  const w0 = (2 * Math.PI * f) / fs
  const cw = Math.cos(w0), sw = Math.sin(w0)
  const A = Math.pow(10, G / 40)
  let b: number[], a: number[]
  if (type === 'peaking') {
    const al = sw / (2 * Q)
    b = [1 + al * A, -2 * cw, 1 - al * A]
    a = [1 + al / A, -2 * cw, 1 - al / A]
  } else if (type === 'lowpass' || type === 'highpass') {
    const al = sw / (2 * Math.pow(10, Q / 20)) // Q は dB
    if (type === 'lowpass') {
      b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
    } else {
      b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
    }
    a = [1 + al, -2 * cw, 1 - al]
  } else {
    const S = 1
    const al = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2)
    const sA = 2 * Math.sqrt(A) * al
    if (type === 'lowshelf') {
      b = [A * (A + 1 - (A - 1) * cw + sA), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - sA)]
      a = [A + 1 + (A - 1) * cw + sA, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - sA]
    } else {
      b = [A * (A + 1 + (A - 1) * cw + sA), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - sA)]
      a = [A + 1 - (A - 1) * cw + sA, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - sA]
    }
  }
  return { b: b.map((v) => v / a[0]), a: a.map((v) => v / a[0]) }
}

describe('Web Audio の BiquadFilterNode と同じ係数', () => {
  const bands: EqBand[] = [
    { type: 'highpass', freq: 104 },
    { type: 'lowpass', freq: 8000 },
    { type: 'lowshelf', freq: 176, gain_db: 3 },
    { type: 'highshelf', freq: 5000, gain_db: -4 },
    { type: 'bell', freq: 3000, gain_db: 3, q: 1 },
    { type: 'bell', freq: 500, gain_db: -6, q: 2 },
  ]
  for (const fs of [24000, 48000]) {
    for (const band of bands) {
      it(`${band.type} ${band.freq} @${fs}`, () => {
        const w = webAudioBiquad(band, fs)!
        const spec = webAudioSpec(w.type, w.frequency, w.Q, w.gain, fs)
        const c = biquadCoefs(band, fs)!
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(spec.b[i] - c.b[i])).toBeLessThan(1e-9)
          expect(Math.abs(spec.a[i] - c.a[i])).toBeLessThan(1e-9)
        }
      })
    }
  }
  it('hp/lp の Q は約 -3.0103 dB', () => {
    expect(webAudioBiquad({ type: 'highpass', freq: 100 })!.Q).toBeCloseTo(-3.0103, 4)
  })
})
