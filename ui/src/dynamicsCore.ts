// コンプ／ゲートの計算（engine の make_compressor / make_gate と同じ式）。
// 0.25ms ごとのブロックでピークを見て、ブロックごとに音量を更新する。
// エンジンは「ブロックのピークから出した音量を同じブロックに掛ける」ので、
// ストリーミングでは出力を 1 ブロック遅らせて同じ結果にしている。
// 音量はブロック間を直線（dB）でつなぐ（前のブロックの値 → 今のブロックの値）。

import { compStaticGainDb } from './dsp'

export interface CompressorParams {
  threshold_db: number
  ratio: number
  knee?: number
  attack_ms?: number
  release_ms?: number
  makeup_db?: number
  dry_mix?: number
}

export interface GateParams {
  threshold_db: number
  range_db?: number
  attack_ms?: number
  hold_ms?: number
  release_ms?: number
}

const blockOf = (fs: number) => Math.max(1, Math.floor(fs * 0.00025))
const toDb = (peak: number) => 20 * Math.log10(Math.max(peak, 1e-9))

// 共通部分：ブロックの蓄積、遅延、音量の適用
abstract class DynamicsBase {
  readonly block: number
  protected fs: number
  protected ring: Float32Array[] = [] // チャンネルごとの 1 ブロック分の遅延
  protected pos = 0
  protected peak = 0
  protected gFrom = 0 // 出力中のブロックの音量の始点（dB）＝1 つ前のブロックの値
  protected gTo = 0 // 同じく終点（dB）＝そのブロック自身の値
  protected cur = 0 // なめらかにした音量（dB）
  protected started = false
  protected ca = 0
  protected cr = 0
  lastInDb = -180
  lastGainDb = 0
  lastOutDb = -180

  constructor(fs: number) {
    this.fs = fs
    this.block = blockOf(fs)
  }

  // 出力の遅れ（サンプル）
  get latencySamples(): number {
    return this.block
  }

  protected ensure(ch: number): void {
    while (this.ring.length < ch) this.ring.push(new Float32Array(this.block))
  }

  // 1 ブロック終わったときに音量を更新する
  protected abstract endBlock(peak: number): void
  // dB を掛ける倍率にする（メイクアップはここ）
  protected abstract gainOf(db: number): number
  // 遅延した音に音量をかける（dry_mix などはここ）
  protected abstract mix(delayed: number, gain: number): number

  process(inputs: Float32Array[], outputs: Float32Array[]): void {
    const nch = Math.min(inputs.length, outputs.length)
    if (nch === 0) return
    this.ensure(nch)
    const n = inputs[0].length
    const block = this.block
    for (let i = 0; i < n; i++) {
      const p = this.pos
      const gain = this.gainOf(
        this.gFrom === this.gTo ? this.gFrom : this.gFrom + ((this.gTo - this.gFrom) * (p + 1)) / block,
      )
      for (let c = 0; c < nch; c++) {
        const x = inputs[c][i]
        const ax = x < 0 ? -x : x
        if (ax > this.peak) this.peak = ax
        const ring = this.ring[c]
        const d = ring[p]
        ring[p] = x
        outputs[c][i] = this.mix(d, gain)
      }
      if (++this.pos >= block) {
        this.pos = 0
        const pk = this.peak
        this.peak = 0
        this.endBlock(pk)
        this.started = true
      }
    }
  }

  reset(): void {
    for (const r of this.ring) r.fill(0)
    this.pos = 0
    this.peak = 0
    this.started = false
  }
}

export class CompressorCore extends DynamicsBase {
  static latencySamples(fs: number): number {
    return blockOf(fs)
  }
  private thr = -10
  private ratio = 4
  private knee = 0
  private kneeRaw = 0
  private makeupDb = 0
  private makeup = 1
  private dry = 0

  constructor(fs: number, params?: CompressorParams) {
    super(fs)
    this.setParams(params ?? { threshold_db: -10, ratio: 4 })
  }

  // 途中で変えても音量の状態（cur）は残す
  setParams(p: CompressorParams): void {
    this.thr = p.threshold_db
    this.ratio = p.ratio
    this.kneeRaw = p.knee ?? 0
    this.knee = this.kneeRaw
    const attack = Math.max(p.attack_ms ?? 1, 0.01) / 1000
    const release = Math.max(p.release_ms ?? 100, 0.01) / 1000
    this.ca = Math.exp(-this.block / (attack * this.fs))
    this.cr = Math.exp(-this.block / (release * this.fs))
    this.makeupDb = p.makeup_db ?? 0
    this.makeup = Math.pow(10, this.makeupDb / 20)
    this.dry = p.dry_mix ?? 0
  }

  protected endBlock(peak: number): void {
    const level = toDb(peak)
    const t = compStaticGainDb(level, this.thr, this.ratio, this.knee)
    const c = t < this.cur ? this.ca : this.cr // 下げるときはアタック
    this.gFrom = this.cur
    this.cur = t + c * (this.cur - t)
    this.gTo = this.cur
    this.lastInDb = level
    this.lastGainDb = this.cur
    this.lastOutDb = level + this.cur + this.makeupDb
  }

  protected gainOf(db: number): number {
    return Math.pow(10, db / 20) * this.makeup
  }

  protected mix(d: number, g: number): number {
    const y = d * g
    return this.dry > 0 ? (1 - this.dry) * y + this.dry * d : y
  }

  reset(): void {
    super.reset()
    this.cur = 0
    this.gFrom = this.gTo = 0
  }
}

export class GateCore extends DynamicsBase {
  static latencySamples(fs: number): number {
    return blockOf(fs)
  }
  private thr = -50
  private rng = 30
  private holdBlocks = 0
  private hold = 0

  constructor(fs: number, params?: GateParams) {
    super(fs)
    this.setParams(params ?? { threshold_db: -50 })
    this.cur = -this.rng // 最初は閉じている
    this.gFrom = this.gTo = this.cur
  }

  setParams(p: GateParams): void {
    this.thr = p.threshold_db
    this.rng = p.range_db ?? 30
    const attack = Math.max(p.attack_ms ?? 1, 0.01) / 1000
    const release = Math.max(p.release_ms ?? 150, 0.01) / 1000
    this.holdBlocks = Math.max(0, Math.round(((p.hold_ms ?? 50) / 1000) * this.fs / this.block))
    this.ca = Math.exp(-this.block / (attack * this.fs))
    this.cr = Math.exp(-this.block / (release * this.fs))
    // まだ動き出す前なら、閉じた状態を新しい range に合わせる
    if (!this.started) {
      this.cur = -this.rng
      this.gFrom = this.gTo = this.cur
    }
  }

  protected endBlock(peak: number): void {
    const level = toDb(peak)
    let t: number
    if (level >= this.thr) {
      this.hold = this.holdBlocks
      t = 0
    } else if (this.hold > 0) {
      this.hold--
      t = 0
    } else {
      t = -this.rng
    }
    const c = t > this.cur ? this.ca : this.cr // 開くときがアタック
    this.gFrom = this.cur
    this.cur = t + c * (this.cur - t)
    this.gTo = this.cur
    this.lastInDb = level
    this.lastGainDb = this.cur
    this.lastOutDb = level + this.cur
  }

  protected gainOf(db: number): number {
    return Math.pow(10, db / 20)
  }

  protected mix(d: number, g: number): number {
    return d * g
  }

  reset(): void {
    super.reset()
    this.hold = 0
    this.cur = -this.rng
    this.gFrom = this.gTo = this.cur
  }
}
