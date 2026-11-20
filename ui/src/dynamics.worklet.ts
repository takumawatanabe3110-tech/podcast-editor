// AudioWorklet：コンプとゲート。dynamicsCore を包むだけ（DOM には依存しない）。
import { CompressorCore, GateCore } from './dynamicsCore'

// AudioWorklet のグローバルは DOM の型にないので最小限だけ宣言する
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, ctor: new (options?: any) => AudioWorkletProcessor): void

interface Core {
  setParams(p: any): void
  process(i: Float32Array[], o: Float32Array[]): void
  lastInDb: number
  lastGainDb: number
  lastOutDb: number
}

const METER_INTERVAL = 1 / 30 // 秒

function makeProcessor(make: (fs: number) => Core) {
  return class extends AudioWorkletProcessor {
    private core: Core
    private since = 0

    constructor(options?: { processorOptions?: { params?: unknown } }) {
      super(options)
      this.core = make(sampleRate)
      const p = options?.processorOptions?.params
      if (p) this.core.setParams(p)
      this.port.onmessage = (e: MessageEvent) => {
        if (e.data && e.data.type === 'params') this.core.setParams(e.data.params)
      }
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const inp = inputs[0]
      const out = outputs[0]
      if (!out || out.length === 0) return true
      if (!inp || inp.length === 0) {
        for (const ch of out) ch.fill(0) // 入力なし
        return true
      }
      this.core.process(inp, out)
      this.since += out[0].length / sampleRate
      if (this.since >= METER_INTERVAL) {
        this.since = 0
        this.port.postMessage({ inDb: this.core.lastInDb, gainDb: this.core.lastGainDb, outDb: this.core.lastOutDb })
      }
      return true
    }
  }
}

registerProcessor('pod-compressor', makeProcessor((fs) => new CompressorCore(fs)))
registerProcessor('pod-gate', makeProcessor((fs) => new GateCore(fs)))
