// EQ・ダイナミクスの計算（engine/podcast_engine/effects.py と同じ式）。画面表示とWeb Audio用。

export type BandType = 'highpass' | 'lowpass' | 'lowshelf' | 'highshelf' | 'bell'

export interface EqBand {
  type: BandType
  freq: number
  gain_db?: number
  q?: number
  enabled?: boolean
}

export interface BiquadCoefs {
  b: [number, number, number]
  a: [number, number, number] // a[0] は常に 1
}

// RBJ の係数。エンジンの _biquad と同じ（シェルフは傾き S=1）
function rbj(kind: BandType, freq: number, gainDb: number, q: number, fs: number): BiquadCoefs {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * freq) / fs
  const cw = Math.cos(w0)
  const sw = Math.sin(w0)
  let b: number[]
  let a: number[]
  if (kind === 'bell') {
    const alpha = sw / (2 * q)
    b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
    a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
  } else if (kind === 'lowshelf' || kind === 'highshelf') {
    const alpha = (sw / 2) * Math.SQRT2
    const sA = 2 * Math.sqrt(A) * alpha
    if (kind === 'lowshelf') {
      b = [A * (A + 1 - (A - 1) * cw + sA), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - sA)]
      a = [A + 1 + (A - 1) * cw + sA, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - sA]
    } else {
      b = [A * (A + 1 + (A - 1) * cw + sA), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - sA)]
      a = [A + 1 - (A - 1) * cw + sA, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - sA]
    }
  } else if (kind === 'lowpass') {
    // 2次バターワース（Q=1/√2）。プリワープ付き双一次変換と同じ結果
    const alpha = sw / (2 * Math.SQRT1_2)
    b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
    a = [1 + alpha, -2 * cw, 1 - alpha]
  } else {
    const alpha = sw / (2 * Math.SQRT1_2)
    b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
    a = [1 + alpha, -2 * cw, 1 - alpha]
  }
  const a0 = a[0]
  return { b: [b[0] / a0, b[1] / a0, b[2] / a0], a: [1, a[1] / a0, a[2] / a0] }
}

// このバンドが何もしない（エンジンが飛ばす）かどうか
function isSkipped(band: EqBand, fs: number): boolean {
  if (band.enabled === false) return true
  if (band.type === 'highpass' || band.type === 'lowpass') return band.freq >= fs / 2
  return (band.gain_db ?? 0) === 0
}

export function biquadCoefs(band: EqBand, fs: number): BiquadCoefs | null {
  if (isSkipped(band, fs)) return null
  return rbj(band.type, band.freq, band.gain_db ?? 0, band.q ?? 1, fs)
}

// 周波数 f での振幅（dB）
export function magnitudeDb(c: BiquadCoefs, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs
  const c1 = Math.cos(w), s1 = Math.sin(w)
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = c.b[0] + c.b[1] * c1 + c.b[2] * c2
  const ni = -(c.b[1] * s1 + c.b[2] * s2)
  const dr = 1 + c.a[1] * c1 + c.a[2] * c2
  const di = -(c.a[1] * s1 + c.a[2] * s2)
  const num = nr * nr + ni * ni
  const den = dr * dr + di * di
  return 10 * Math.log10(Math.max(num, 1e-30) / Math.max(den, 1e-30))
}

export function eqResponseDb(
  bands: EqBand[],
  fs: number,
  freqs: ArrayLike<number>,
): { perBand: number[][]; total: number[] } {
  const total = new Array<number>(freqs.length).fill(0)
  const perBand = bands.map((band) => {
    const c = biquadCoefs(band, fs)
    const row = new Array<number>(freqs.length).fill(0)
    if (c) {
      for (let i = 0; i < freqs.length; i++) {
        row[i] = magnitudeDb(c, freqs[i], fs)
        total[i] += row[i]
      }
    }
    return row
  })
  return { perBand, total }
}

export function logFreqs(n: number, fMin = 20, fMax = 20000): number[] {
  const out: number[] = []
  const r = Math.log(fMax / fMin)
  for (let i = 0; i < n; i++) out.push(fMin * Math.exp((r * i) / Math.max(1, n - 1)))
  return out
}

// コンプの静的カーブ：入力レベル(dB)→下げ幅(dB, 0以下)。knee は 0〜100（0〜20 dB に換算）
export function compStaticGainDb(levelDb: number, threshold: number, ratio: number, knee0to100: number): number {
  const kneeDb = (knee0to100 / 100) * 20
  const over = levelDb - threshold
  const slope = 1 / ratio - 1
  let g = over > 0 ? slope * over : 0
  if (kneeDb > 0) {
    const k = kneeDb / 2
    if (Math.abs(over) <= k) g = (slope * (over + k) * (over + k)) / (2 * kneeDb)
  }
  return g
}

// ゲートの静的カーブ：しきい値以上なら 0、未満なら -range
export function gateStaticGainDb(levelDb: number, threshold: number, range: number): number {
  return levelDb >= threshold ? 0 : -range
}

// Web Audio の BiquadFilterNode 用の設定。エンジンと同じ音になる
// - bell → 'peaking'（Q は倍率のまま）
// - シェルフ → Web Audio 仕様の alpha = sin/2*sqrt((A+1/A)(1/S-1)+2) は S=1 で sin/2*√2 になり、エンジンと一致
// - hp/lp は Q を dB で渡す必要がある。バターワース Q=1/√2 → 20*log10(1/√2) ≈ -3.0103
export function webAudioBiquad(
  band: EqBand,
  fs: number = Infinity,
): { type: BiquadFilterType; frequency: number; Q: number; gain: number } | null {
  if (isSkipped(band, fs)) return null
  switch (band.type) {
    case 'bell':
      return { type: 'peaking', frequency: band.freq, Q: band.q ?? 1, gain: band.gain_db ?? 0 }
    case 'lowshelf':
    case 'highshelf':
      return { type: band.type, frequency: band.freq, Q: 1, gain: band.gain_db ?? 0 }
    default:
      return { type: band.type, frequency: band.freq, Q: 20 * Math.log10(Math.SQRT1_2), gain: 0 }
  }
}
