// 再生（Web Audio）。試聴用の音（24kHz）を読み込み、プロジェクトの内容どおりに並べて鳴らす。
// 反映するもの：同期のずれ・ドリフト、カット（飛ばす・つなぎ目のクロスフェード）、声の音量・フェーダー・パン・ミュート・ソロ、
// BGM の位置・音量カーブ・フェード、BGM／マスターのフェーダー。
// まだ反映しないもの：EQ・コンプ（段階3）。代わりに最後に安全用のリミッターを置く。
//
// つなぎ方：声の素材 → つなぎ目のフェード → 声トラック（音量＋フェーダー、ミュート）→ パン → メーター ┐
//           BGM の素材 → 音量カーブ → BGM トラック（フェーダー）→ メーター                          ┤
//           → マスター（フェーダー）→ 試聴の音量 → リミッター → メーター → スピーカー
// トラックの音量はつなぎ直さずに変えられる（ミキサーを動かしてもその場で反映、鳴らし直さない）。
import { getAudio } from './api'
import workletUrl from './dynamics.worklet.ts?worker&url'
import { FxChain } from './fxchain'
import { bgmGainCurve, bgmPieces, outputEnd, voicePieces } from './timeline'
import type { Project } from './types'

const PREVIEW_FS = 24000
const LEAD = 0.05 // 予約してから鳴り始めるまでの余裕（秒）
export const BGM_ID = '__bgm'
export const MASTER_ID = '__master'

const dbToGain = (db: number) => Math.pow(10, db / 20)

/** エフェクトのうち、フェーダー（gain）の合計 dB */
export function faderDb(effects: unknown[]): number {
  let db = 0
  for (const e of effects as { type?: string; db?: number }[]) if (e?.type === 'gain') db += e.db ?? 0
  return db
}

type Listener = () => void

interface Strip { gain: GainNode; fx: FxChain; pan?: StereoPannerNode; meter: AnalyserNode }

export class Player {
  readonly ctx: AudioContext
  private buffers = new Map<string, AudioBuffer>()
  private rawBuffers = new Map<string, AudioBuffer>() // ノイズ除去前（処理前と聴き比べる用）
  private compare = false // true＝処理前（エフェクトもノイズ除去もなし）で鳴らす
  private workletLoaded = false
  private nodes: AudioScheduledSourceNode[] = []
  private strips = new Map<string, Strip>()
  private masterGain: GainNode
  private trim: GainNode
  private trimSet = false
  private outMeter!: AnalyserNode
  private startCtx = 0 // 再生を始めた ctx.currentTime（LEAD 込み）
  private startOut = 0 // そのときの出力時刻
  private pausedAt = 0
  private project: Project | null = null
  private solo = new Set<string>()
  playing = false
  private listeners = new Set<Listener>()

  constructor() {
    this.ctx = new AudioContext({ sampleRate: PREVIEW_FS })
    const limiter = this.ctx.createDynamicsCompressor() // 音割れ防止（書き出しの −1 dBTP リミッターの代わり）
    limiter.threshold.value = -2
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.1
    this.masterGain = this.ctx.createGain()
    this.trim = this.ctx.createGain()
    const meter = this.makeMeter()
    const fx = new FxChain(this.ctx, () => this.workletLoaded, 2)
    this.masterGain.connect(fx.input)
    fx.output.connect(this.trim).connect(limiter).connect(meter).connect(this.ctx.destination)
    this.outMeter = meter
    this.strips.set(MASTER_ID, { gain: this.masterGain, fx, meter })
    // コンプ・ゲート（エンジンと同じ計算）を読み込む。読み込むまでは素通し
    this.ctx.audioWorklet.addModule(workletUrl).then(() => {
      this.workletLoaded = true
      // 音割れ防止を、先読みのリミッター（上限 −1 dBFS）に置き換える。
      // DynamicsCompressor は急な音に間に合わず、フェーダーを上げると 0 dB を超えてジリジリしていた
      const brick = new AudioWorkletNode(this.ctx, 'pod-limiter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
        processorOptions: { params: { ceiling_db: -1, lookahead_ms: 3, release_ms: 80 } },
      })
      this.trim.disconnect()
      limiter.disconnect()
      this.trim.connect(brick).connect(this.outMeter)
      if (this.project) this.updateMix(this.project)
    }, e => console.error('コンプ・ゲートを読み込めませんでした', e))
  }

  /** トラックのエフェクトの部品（EQ の画面の音の成分・コンプのメーター用） */
  chain(id: string): FxChain | undefined { return this.strips.get(id)?.fx }

  /** 処理前（エフェクトもノイズ除去もなし）で聴き比べる */
  async setCompare(on: boolean) {
    if (on && this.project) {
      const sids = this.project.voices.filter(v => v.denoise).map(v => v.source).filter(s => !this.rawBuffers.has(s))
      await Promise.all(sids.map(async sid => this.rawBuffers.set(sid, await this.ctx.decodeAudioData(await getAudio(sid, true)))))
    }
    this.compare = on
    for (const st of this.strips.values()) st.fx.setBypass(on)
    if (this.playing) this.start(this.position())
    this.emit()
  }
  get comparing() { return this.compare }

  /** 素材を読み込み直す（ノイズ除去の設定を変えたとき。サーバーが作り直すので時間がかかる） */
  async reload(sid: string) {
    const buf = await this.ctx.decodeAudioData(await getAudio(sid))
    this.buffers.set(sid, buf)
    if (this.playing) this.start(this.position())
  }

  on(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private emit() { this.listeners.forEach(f => f()) }

  private makeMeter() {
    const a = this.ctx.createAnalyser()
    a.fftSize = 1024
    return a
  }

  /** 素材を読み込む。進み具合を onProgress で知らせる */
  async load(sids: string[], onProgress?: (done: number, total: number) => void) {
    let done = 0
    await Promise.all(sids.map(async sid => {
      if (!this.buffers.has(sid)) this.buffers.set(sid, await this.ctx.decodeAudioData(await getAudio(sid)))
      onProgress?.(++done, sids.length)
    }))
  }

  /** 素材の長さ（秒）。まだ読み込んでいなければ undefined */
  duration(sid: string) { return this.buffers.get(sid)?.duration }

  /** 今の出力時刻 */
  position(): number {
    if (!this.playing) return this.pausedAt
    return this.startOut + Math.max(0, this.ctx.currentTime - this.startCtx)
  }

  setProject(p: Project) {
    this.project = p
    this.updateMix(p)
  }

  /** ソロにするトラック（声の素材ID か BGM_ID）。空ならソロなし */
  setSolo(ids: Set<string>) {
    this.solo = new Set(ids)
    if (this.project) this.updateMix(this.project)
  }

  /** ミキサーの値（音量・フェーダー・パン・ミュート・ソロ）を、鳴らし直さずに反映する */
  updateMix(p: Project) {
    this.project = p
    const now = this.ctx.currentTime
    const set = (param: AudioParam, v: number) => param.setTargetAtTime(v, now, 0.015)
    if (!this.trimSet) {
      // 試聴の音量：最初の設定でフェーダーが上げている分を戻し、完成版（−14 LUFS）に近い大きさで聴く。
      // 一度決めたら変えない（フェーダーを動かしたときに、その差が聞こえるように）
      const fs = p.voices.map(v => faderDb(v.effects))
      const mean = fs.length ? fs.reduce((a, b) => a + b, 0) / fs.length : 0
      this.trim.gain.value = dbToGain(-mean - faderDb(p.master_effects) - 0.4)
      this.trimSet = true
    }
    const soloOn = this.solo.size > 0
    for (const v of p.voices) {
      const s = this.voiceStrip(v.source)
      const silent = v.mute || (soloOn && !this.solo.has(v.source))
      set(s.gain.gain, silent ? 0 : dbToGain(v.gain_db))
      s.fx.set(v.effects) // フェーダー（gain）もエフェクトの並びの中でかかる
      if (s.pan) set(s.pan.pan, v.pan)
    }
    const bgm = this.bgmStrip()
    set(bgm.gain.gain, soloOn && !this.solo.has(BGM_ID) ? 0 : 1)
    bgm.fx.set(p.bgm_effects)
    this.strips.get(MASTER_ID)!.fx.set(p.master_effects)
  }

  private voiceStrip(sid: string): Strip {
    let s = this.strips.get(sid)
    if (!s) {
      const gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner(), meter = this.makeMeter()
      const fx = new FxChain(this.ctx, () => this.workletLoaded, 1)
      gain.connect(fx.input); fx.output.connect(pan).connect(meter).connect(this.masterGain)
      s = { gain, fx, pan, meter }
      this.strips.set(sid, s)
    }
    return s
  }

  private bgmStrip(): Strip {
    let s = this.strips.get(BGM_ID)
    if (!s) {
      const gain = this.ctx.createGain(), meter = this.makeMeter()
      const fx = new FxChain(this.ctx, () => this.workletLoaded, 2)
      gain.connect(fx.input); fx.output.connect(meter).connect(this.masterGain)
      s = { gain, fx, meter }
      this.strips.set(BGM_ID, s)
    }
    return s
  }

  /** 各トラックの今のピーク（dBFS）。鳴っていなければ −Infinity */
  levels(): Record<string, number> {
    const out: Record<string, number> = {}
    const buf = new Float32Array(1024)
    for (const [id, s] of this.strips) {
      s.meter.getFloatTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a }
      out[id] = peak > 0 ? 20 * Math.log10(peak) : -Infinity
    }
    return out
  }

  /** 出力時刻 t へ移動（再生中ならそこから鳴らし直す） */
  seek(t: number) {
    t = Math.max(0, t)
    if (this.playing) this.start(t)
    else { this.pausedAt = t; this.emit() }
  }

  toggle() { if (this.playing) this.pause(); else this.play() }

  play() {
    if (!this.project) return
    let t = this.pausedAt
    if (t >= this.totalLength() - 0.05) t = 0
    void this.ctx.resume()
    this.start(t)
  }

  /** 出力時刻 from から to まで鳴らして止める（BGM の試聴など） */
  playRange(from: number, to: number) {
    if (!this.project) return
    void this.ctx.resume()
    this.start(Math.max(0, from))
    this.stopTimer = window.setTimeout(() => this.pause(), (to - Math.max(0, from)) * 1000 + LEAD * 1000)
  }
  private stopTimer = 0

  pause() {
    this.pausedAt = this.position()
    this.stopNodes()
    this.playing = false
    this.emit()
  }

  /** 並び（カット・BGM の位置など）を変えたあとに呼ぶ。再生中なら位置 t から鳴らし直す */
  restart(p: Project, t: number) {
    this.updateMix(p)
    if (this.playing) this.start(t)
    else { this.pausedAt = t; this.emit() }
  }

  totalLength(): number {
    const p = this.project
    if (!p) return 0
    let end = outputEnd(p.edit)
    for (const piece of bgmPieces(p, 0)) end = Math.max(end, piece.when + piece.duration)
    return end
  }

  private stopNodes() {
    window.clearTimeout(this.stopTimer)
    for (const n of this.nodes) { try { n.stop() } catch { /* まだ始まっていない */ } n.disconnect() }
    this.nodes = []
  }

  private start(fromOut: number) {
    const p = this.project!
    this.stopNodes()
    const ctx = this.ctx
    const t0 = ctx.currentTime + LEAD
    this.startCtx = t0
    this.startOut = fromOut
    this.playing = true

    for (const v of p.voices) {
      const buf = (this.compare && this.rawBuffers.get(v.source)) || this.buffers.get(v.source)
      if (!buf) continue
      const strip = this.voiceStrip(v.source)
      for (const pc of voicePieces(p, v.source, fromOut)) {
        if (pc.fileStart >= buf.duration) continue
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.playbackRate.value = pc.rate
        const fg = ctx.createGain() // つなぎ目のクロスフェード
        const a = t0 + pc.when, b = a + pc.duration
        if (pc.fadeIn > 0) { fg.gain.setValueAtTime(0, a); fg.gain.linearRampToValueAtTime(1, a + pc.fadeIn) }
        if (pc.fadeOut > 0) { fg.gain.setValueAtTime(1, Math.max(a, b - pc.fadeOut)); fg.gain.linearRampToValueAtTime(0, b) }
        src.connect(fg).connect(strip.gain)
        src.start(a, pc.fileStart, pc.duration * pc.rate)
        this.nodes.push(src)
      }
    }

    const bgm = this.bgmStrip()
    for (const pc of bgmPieces(p, fromOut)) {
      const clip = p.bgm[pc.clipIndex]
      const buf = this.buffers.get(clip.source)
      if (!buf || pc.duration <= 0) continue
      const src = ctx.createBufferSource()
      src.buffer = buf
      const g = ctx.createGain()
      const a = t0 + pc.when
      const curve = bgmGainCurve(clip, pc.clipT0, clip.duration, 50)
      g.gain.setValueAtTime(curve[0], a)
      g.gain.setValueCurveAtTime(curve, a, pc.duration)
      src.connect(g).connect(bgm.gain)
      src.start(a, pc.offset, pc.duration)
      this.nodes.push(src)
    }
    this.emit()
  }
}
