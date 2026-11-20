// 試聴の最後に置くリミッター（先読みあり）。音が上限（既定 −1 dBFS）を超えないようにする。
// 少し先（既定 3 ms）の音を見て、超えそうなら前もってなめらかに下げる。それでも超えた分だけ最後に切る（めったに起きない）。
// これまでの DynamicsCompressor は急な音に間に合わず、フェーダーを上げると 0 dB を超えて音割れ（ジリジリ）していた。

export interface LimiterParams { ceiling_db?: number; lookahead_ms?: number; release_ms?: number }

export class LimiterCore {
  private ceiling = 1
  private look = 1
  private rel = 0
  private att = 0
  private delay: Float32Array[] = []
  private pos = 0
  private gain = 1
  // 遅らせている音それぞれに必要な下げ幅（1＝下げない）
  private need: Float32Array = new Float32Array(1)
  lastGainDb = 0

  constructor(private fs: number, p: LimiterParams = {}) { this.setParams(p) }

  setParams(p: LimiterParams) {
    this.ceiling = Math.pow(10, (p.ceiling_db ?? -1) / 20)
    const look = Math.max(1, Math.round(((p.lookahead_ms ?? 3) / 1000) * this.fs))
    if (look !== this.look || this.need.length !== look) {
      this.look = look
      this.need = new Float32Array(look).fill(1)
      this.delay = []
      this.pos = 0
    }
    this.rel = Math.exp(-1 / (((p.release_ms ?? 80) / 1000) * this.fs))
    this.att = Math.exp(-4 / look) // 先読みの区間のうちにほぼ下げ終わる速さ
  }

  get latencySamples() { return this.look }

  process(inputs: Float32Array[], outputs: Float32Array[]) {
    const n = outputs[0]?.length ?? 0
    const chs = Math.min(inputs.length, outputs.length)
    while (this.delay.length < chs) this.delay.push(new Float32Array(this.look))
    let minGain = 1
    for (let i = 0; i < n; i++) {
      // 入ってきた音に必要な下げ幅（全チャンネル共通）
      let peak = 0
      for (let c = 0; c < chs; c++) { const a = Math.abs(inputs[c][i]); if (a > peak) peak = a }
      const needNew = peak > this.ceiling ? this.ceiling / peak : 1
      // 先読みの区間（これから出ていく音と、いま入った音）で一番小さい値に向かって動く。
      // 下げるときは速く（区間のうちにほぼ下げ終わる）、戻すときはリリースの速さで
      let target = needNew
      for (let k = 0; k < this.look; k++) if (this.need[k] < target) target = this.need[k]
      const c0 = target < this.gain ? this.att : this.rel
      this.gain = target + c0 * (this.gain - target)
      if (this.gain < minGain) minGain = this.gain
      for (let c = 0; c < chs; c++) {
        const d = this.delay[c]
        let y = d[this.pos] * this.gain
        // それでも超えた分だけ切る（安全のため）
        if (y > this.ceiling) y = this.ceiling
        else if (y < -this.ceiling) y = -this.ceiling
        outputs[c][i] = y
        d[this.pos] = inputs[c][i]
      }
      this.need[this.pos] = needNew
      this.pos = (this.pos + 1) % this.look
    }
    for (let c = chs; c < outputs.length; c++) outputs[c].fill(0)
    this.lastGainDb = 20 * Math.log10(minGain)
  }
}
