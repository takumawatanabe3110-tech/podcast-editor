// 再生（Web Audio）。試聴用の音（24kHz）を読み込み、プロジェクトの内容どおりに並べて鳴らす。
// 反映するもの：同期のずれ・ドリフト、カット（飛ばす・つなぎ目のクロスフェード）、声の音量・フェーダー・パン・ミュート、
// BGM の位置・音量カーブ・フェード、マスターのフェーダー。
// まだ反映しないもの：EQ・コンプ・ノイズ除去以外のエフェクト（次の段階）。代わりに最後に安全用のリミッターを置く。
import { getAudio } from './api'
import { bgmGainCurve, bgmPieces, outputEnd, voicePieces } from './timeline'
import type { Project } from './types'

const PREVIEW_FS = 24000
const LEAD = 0.05 // 予約してから鳴り始めるまでの余裕（秒）

const dbToGain = (db: number) => Math.pow(10, db / 20)

/** エフェクトのうち、フェーダー（gain）の合計 dB */
export function faderDb(effects: unknown[]): number {
  let db = 0
  for (const e of effects as { type?: string; db?: number }[]) if (e?.type === 'gain') db += e.db ?? 0
  return db
}

type Listener = () => void

export class Player {
  readonly ctx: AudioContext
  private buffers = new Map<string, AudioBuffer>()
  private nodes: AudioScheduledSourceNode[] = []
  private master: GainNode
  private startCtx = 0 // 再生を始めた ctx.currentTime（LEAD 込み）
  private startOut = 0 // そのときの出力時刻
  private pausedAt = 0
  private project: Project | null = null
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
    this.master = this.ctx.createGain()
    this.master.connect(limiter).connect(this.ctx.destination)
  }

  on(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private emit() { this.listeners.forEach(f => f()) }

  /** 素材を読み込む。進み具合を onProgress（0〜1）で知らせる */
  async load(sids: string[], onProgress?: (done: number, total: number) => void) {
    let done = 0
    await Promise.all(sids.map(async sid => {
      if (!this.buffers.has(sid)) this.buffers.set(sid, await this.ctx.decodeAudioData(await getAudio(sid)))
      onProgress?.(++done, sids.length)
    }))
  }

  /** 今の出力時刻 */
  position(): number {
    if (!this.playing) return this.pausedAt
    return this.startOut + Math.max(0, this.ctx.currentTime - this.startCtx)
  }

  setProject(p: Project) { this.project = p }

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

  pause() {
    this.pausedAt = this.position()
    this.stopNodes()
    this.playing = false
    this.emit()
  }

  /** プロジェクトを変えたあとに呼ぶ。再生中なら位置 t から鳴らし直す */
  restart(p: Project, t: number) {
    this.project = p
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

    // 試聴の音量：フェーダーで上げた分を戻し、完成版（−14 LUFS 前後）に近い大きさで聴く
    const voiceFaders = p.voices.map(v => faderDb(v.effects))
    const meanFader = voiceFaders.length ? voiceFaders.reduce((a, b) => a + b, 0) / voiceFaders.length : 0
    this.master.gain.value = dbToGain(-meanFader - faderDb(p.master_effects) - 0.4)

    p.voices.forEach((v, i) => {
      const buf = this.buffers.get(v.source)
      if (!buf || v.mute) return
      const g = ctx.createGain()
      g.gain.value = dbToGain(v.gain_db + voiceFaders[i] + faderDb(p.master_effects))
      const pan = ctx.createStereoPanner()
      pan.pan.value = v.pan
      g.connect(pan).connect(this.master)
      for (const pc of voicePieces(p, v.source, fromOut)) {
        if (pc.fileStart >= buf.duration) continue
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.playbackRate.value = pc.rate
        const fg = ctx.createGain() // つなぎ目のクロスフェード
        const a = t0 + pc.when, b = a + pc.duration
        if (pc.fadeIn > 0) { fg.gain.setValueAtTime(0, a); fg.gain.linearRampToValueAtTime(1, a + pc.fadeIn) }
        if (pc.fadeOut > 0) { fg.gain.setValueAtTime(1, Math.max(a, b - pc.fadeOut)); fg.gain.linearRampToValueAtTime(0, b) }
        src.connect(fg).connect(g)
        src.start(a, pc.fileStart, pc.duration * pc.rate)
        this.nodes.push(src)
      }
    })

    const bgmBus = ctx.createGain()
    bgmBus.gain.value = dbToGain(faderDb(p.bgm_effects) + faderDb(p.master_effects))
    bgmBus.connect(this.master)
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
      src.connect(g).connect(bgmBus)
      src.start(a, pc.offset, pc.duration)
      this.nodes.push(src)
    }
    this.emit()
  }
}
