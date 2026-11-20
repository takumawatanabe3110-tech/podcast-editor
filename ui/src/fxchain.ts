// トラックのエフェクト（.podproj の effects）を Web Audio の部品で組み立てる。
// 上から順に：EQ（BiquadFilter）・コンプ／ゲート（AudioWorklet、エンジンと同じ計算）・音量（Gain）・リミッター（近似）。
// 並び（種類・順番・オン／オフ）が同じなら、値だけ変える（つなぎ直さないので、ドラッグ中も音が途切れない）。
// 処理前（bypass）のときは、エフェクトを通さず、フェーダー（gain）の分だけ音量を合わせて鳴らす。
import { webAudioBiquad } from './dsp'

type Fx = { type?: string; enabled?: boolean; [k: string]: unknown }
type Band = { type: string; freq: number; gain_db?: number; q?: number; enabled?: boolean }

export interface Meters { inDb: number; gainDb: number; outDb: number }

interface Built { kind: string; nodes: AudioNode[]; worklet?: AudioWorkletNode; meters?: Meters }

const dbToGain = (db: number) => Math.pow(10, db / 20)

/** 並びの印。これが変わったときだけ組み直す */
function signature(effects: Fx[]): string {
  return effects.map(e => {
    if (e.enabled === false) return 'off'
    if (e.type === 'eq') return 'eq(' + ((e.bands as Band[]) ?? []).map(b => (b.enabled === false ? '-' : b.type)).join(',') + ')'
    return String(e.type)
  }).join('|')
}

function gainOfFaders(effects: Fx[]): number {
  let db = 0
  for (const e of effects) if (e.type === 'gain' && e.enabled !== false) db += Number(e.db ?? 0)
  return db
}

export class FxChain {
  readonly input: GainNode
  readonly output: GainNode
  readonly pre: AnalyserNode // 処理前の音の成分（EQ の画面用）
  readonly post: AnalyserNode // 処理後
  private wet: GainNode
  private dry: GainNode
  private built: Built[] = []
  private sig = ''
  private effects: Fx[] = []
  private bypassed = false

  constructor(private ctx: AudioContext, private workletReady: () => boolean, private channels = 1) {
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.wet = ctx.createGain()
    this.dry = ctx.createGain()
    this.pre = ctx.createAnalyser(); this.pre.fftSize = 4096; this.pre.smoothingTimeConstant = 0.8
    this.post = ctx.createAnalyser(); this.post.fftSize = 4096; this.post.smoothingTimeConstant = 0.8
    this.input.connect(this.pre)
    this.input.connect(this.dry).connect(this.output)
    this.wet.connect(this.output)
    this.output.connect(this.post)
    this.dry.gain.value = 0
    this.input.connect(this.wet) // エフェクトがないときの通り道（set で組み直す）
    this.built = []
  }

  setBypass(on: boolean) {
    this.bypassed = on
    this.applyMix()
  }

  private applyMix() {
    const t = this.ctx.currentTime
    this.wet.gain.setTargetAtTime(this.bypassed ? 0 : 1, t, 0.01)
    this.dry.gain.setTargetAtTime(this.bypassed ? dbToGain(gainOfFaders(this.effects)) : 0, t, 0.01)
  }

  /** i 番目のエフェクト（コンプ・ゲート）の今のメーター */
  meters(i: number): Meters | undefined { return this.built[i]?.meters }

  set(effects: unknown[]) {
    const list = (effects ?? []) as Fx[]
    this.effects = list
    const sig = signature(list)
    if (sig !== this.sig || this.built.some(b => b.kind === 'pending' && this.workletReady())) this.rebuild(list, sig)
    else list.forEach((e, i) => this.update(this.built[i], e))
    this.applyMix()
  }

  private rebuild(list: Fx[], sig: string) {
    // 古い部品を外す（入口は一度全部外して、処理前のメーターと素通しの道だけつなぎ直す）
    this.input.disconnect()
    this.input.connect(this.pre)
    this.input.connect(this.dry)
    for (const b of this.built) for (const n of b.nodes) n.disconnect()
    for (const b of this.built) b.worklet?.port.close()
    this.built = list.map(e => this.make(e))
    this.sig = sig
    let prev: AudioNode = this.input
    for (const b of this.built) for (const n of b.nodes) { prev.connect(n); prev = n }
    prev.connect(this.wet)
  }

  private make(e: Fx): Built {
    const ctx = this.ctx
    if (e.enabled === false) return { kind: 'off', nodes: [] }
    switch (e.type) {
      case 'eq': {
        const nodes = ((e.bands as Band[]) ?? []).filter(b => b.enabled !== false).map(() => ctx.createBiquadFilter())
        const b: Built = { kind: 'eq', nodes }
        this.update(b, e)
        return b
      }
      case 'gain': {
        const g = ctx.createGain()
        g.gain.value = dbToGain(Number(e.db ?? 0))
        return { kind: 'gain', nodes: [g] }
      }
      case 'compressor':
      case 'gate': {
        if (!this.workletReady()) return { kind: 'pending', nodes: [] } // 読み込み前は素通し（読み込んだら組み直す）
        const meters: Meters = { inDb: -Infinity, gainDb: 0, outDb: -Infinity }
        const node = new AudioWorkletNode(ctx, e.type === 'gate' ? 'pod-gate' : 'pod-compressor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [this.channels],
          channelCount: this.channels, channelCountMode: 'explicit',
          processorOptions: { params: e },
        })
        node.port.onmessage = ev => { const m = ev.data as Meters; meters.inDb = m.inDb; meters.gainDb = m.gainDb; meters.outDb = m.outDb }
        return { kind: e.type, nodes: [node], worklet: node, meters }
      }
      case 'limiter': {
        const c = ctx.createDynamicsCompressor() // 書き出しのリミッターの近似（先読みなし）
        const b: Built = { kind: 'limiter', nodes: [c] }
        this.update(b, e)
        return b
      }
      default:
        return { kind: 'unknown', nodes: [] }
    }
  }

  private update(b: Built | undefined, e: Fx) {
    if (!b) return
    const t = this.ctx.currentTime
    if (b.kind === 'eq') {
      const bands = ((e.bands as Band[]) ?? []).filter(x => x.enabled !== false)
      bands.forEach((band, i) => {
        const f = b.nodes[i] as BiquadFilterNode
        const nyq = this.ctx.sampleRate / 2 - 1
        // エンジンが素通しにするバンド（0 dB のベル・シェルフ、ナイキスト以上のハイパス／ローパス）は平らな形にする
        const flat = { type: (band.type === 'highpass' || band.type === 'lowpass' ? 'allpass' : band.type === 'bell' ? 'peaking' : band.type) as BiquadFilterType, frequency: Math.min(band.freq, nyq), Q: 0.7, gain: 0 }
        const w = webAudioBiquad(band as never, this.ctx.sampleRate) ?? flat
        if (f.type !== w.type) f.type = w.type
        f.frequency.setTargetAtTime(Math.min(w.frequency, nyq), t, 0.01)
        f.Q.setTargetAtTime(w.Q, t, 0.01)
        f.gain.setTargetAtTime(w.gain, t, 0.01)
      })
    } else if (b.kind === 'gain') {
      (b.nodes[0] as GainNode).gain.setTargetAtTime(dbToGain(Number(e.db ?? 0)), t, 0.01)
    } else if (b.worklet) {
      b.worklet.port.postMessage({ type: 'params', params: e })
    } else if (b.kind === 'limiter') {
      const c = b.nodes[0] as DynamicsCompressorNode
      c.threshold.value = Number(e.ceiling_db ?? -1)
      c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001
      c.release.value = Math.max(0.01, Number(e.release_ms ?? 50) / 1000)
    }
  }
}
