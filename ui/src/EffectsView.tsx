// ③④ エフェクト：選んだトラックの EQ・ダイナミクス（ゲート＋コンプ）・フェーダーを1つの画面で同時に調整する（Resolve のチャンネルの画面のように）。
// かかる順番は ノイズ除去 → EQ → ダイナミクス → フェーダー（EQ とダイナミクスの順は入れ替えられる）。
// 再生中は、EQ の処理前・処理後の音の成分、ダイナミクスの下げた量と音量の動き、フェーダーのメーターがその場で動く。
import { useEffect, useRef, useState } from 'react'
import { compStaticGainDb, eqResponseDb, gateStaticGainDb, logFreqs } from './dsp'
import { withFader } from './Mixer'
import { BGM_ID, MASTER_ID, faderDb, type Player } from './player'
import { usePlayhead } from './playhead'
import type { Project } from './types'

type Fx = { type: string; enabled?: boolean; [k: string]: any } // eslint-disable-line @typescript-eslint/no-explicit-any
type Band = { type: string; freq: number; gain_db?: number; q?: number; enabled?: boolean }

const BAND_COLORS = ['#FF8A8A', '#F2A65A', '#E5D35A', '#6DD08A', '#5FD3E6', '#B79CFF', '#E58AE0', '#9BB0C8']
const BAND_TYPES: [string, string][] = [['highpass', 'ハイパス'], ['lowshelf', 'ローシェルフ'], ['bell', 'ベル'], ['highshelf', 'ハイシェルフ'], ['lowpass', 'ローパス']]

const NEW_FX: Record<string, Fx> = {
  eq: { type: 'eq', bands: [
    { type: 'highpass', freq: 80 }, { type: 'lowshelf', freq: 200, gain_db: 0 },
    { type: 'bell', freq: 1000, gain_db: 0, q: 1 }, { type: 'bell', freq: 3000, gain_db: 0, q: 1 }, { type: 'highshelf', freq: 6000, gain_db: 0 }] },
  compressor: { type: 'compressor', threshold_db: -20, ratio: 3, knee: 30, attack_ms: 5, release_ms: 100, makeup_db: 0, dry_mix: 0 },
  gate: { type: 'gate', threshold_db: -50, range_db: 20, attack_ms: 1, hold_ms: 50, release_ms: 150 },
  limiter: { type: 'limiter', ceiling_db: -1, release_ms: 50 },
}

export type TrackId = string // 声の素材ID / BGM_ID / MASTER_ID

function trackEffects(p: Project, id: TrackId): Fx[] {
  if (id === MASTER_ID) return p.master_effects as Fx[]
  if (id === BGM_ID) return p.bgm_effects as Fx[]
  return (p.voices.find(v => v.source === id)?.effects ?? []) as Fx[]
}

function withTrackEffects(p: Project, id: TrackId, fx: Fx[]): Project {
  if (id === MASTER_ID) return { ...p, master_effects: fx }
  if (id === BGM_ID) return { ...p, bgm_effects: fx }
  return { ...p, voices: p.voices.map(v => (v.source === id ? { ...v, effects: fx } : v)) }
}

// ---------------------------------------------------------------- 並びの操作（エンジンには上から順のリストで渡す）

const isDyn = (e: Fx) => e.type === 'gate' || e.type === 'compressor'
const idxOf = (fx: Fx[], type: string) => fx.findIndex(e => e.type === type)

/** EQ がダイナミクスより前か（どちらかがなければ前とみなす） */
export function eqFirst(fx: Fx[]): boolean {
  const e = idxOf(fx, 'eq'), d = fx.findIndex(isDyn)
  return e < 0 || d < 0 || e < d
}

/** type のエフェクトを置き換える。なければ決まった場所に入れる（フェーダー・リミッターより前） */
export function putFx(fx: Fx[], e: Fx): Fx[] {
  const i = idxOf(fx, e.type)
  if (i >= 0) return fx.map((x, k) => (k === i ? e : x))
  const list = [...fx]
  const tail = list.findIndex(x => x.type === 'gain' || x.type === 'limiter')
  let at = tail >= 0 ? tail : list.length
  const ei = idxOf(list, 'eq'), gi = idxOf(list, 'gate'), ci = idxOf(list, 'compressor')
  const first = eqFirst(list)
  if (e.type === 'eq') {
    const dyn = list.map((x, k) => (isDyn(x) ? k : -1)).filter(k => k >= 0)
    if (dyn.length) at = first ? dyn[0] : dyn[dyn.length - 1] + 1
  } else if (e.type === 'gate') {
    if (ci >= 0) at = ci
    else if (ei >= 0) at = first ? ei + 1 : ei
  } else if (e.type === 'compressor') {
    if (gi >= 0) at = gi + 1
    else if (ei >= 0) at = first ? ei + 1 : ei
  } else if (e.type === 'limiter') at = list.length
  list.splice(at, 0, e)
  return list
}

/** ダイナミクスの中は ゲート → コンプ の順にそろえる（Resolve と同じ） */
export function gateBeforeComp(fx: Fx[]): Fx[] {
  const gi = idxOf(fx, 'gate'), ci = idxOf(fx, 'compressor')
  if (gi < 0 || ci < 0 || gi < ci) return fx
  const list = [...fx];[list[gi], list[ci]] = [list[ci], list[gi]]
  return list
}

/** EQ とダイナミクスの順番を入れ替える */
export function setOrder(fx: Fx[], eqBefore: boolean): Fx[] {
  const eq = fx.find(e => e.type === 'eq'), dyn = fx.filter(isDyn)
  if (!eq || !dyn.length) return fx
  const first = fx.findIndex(e => e.type === 'eq' || isDyn(e))
  const rest = fx.filter(e => e.type !== 'eq' && !isDyn(e))
  const block = eqBefore ? [eq, ...dyn] : [...dyn, eq]
  return [...rest.slice(0, first), ...block, ...rest.slice(first)]
}

// ---------------------------------------------------------------- 画面

interface Props {
  project: Project; player: Player; colors: string[]
  onChange: (p: Project, group?: string) => void
  denoiseBusy: Record<string, boolean>
  track: TrackId | null; setTrack: (t: TrackId) => void // 選んだトラック（App が持つ。そのトラックだけ鳴らすため）
}

export function EffectsView({ project, player, colors, onChange, denoiseBusy, track: picked, setTrack }: Props) {
  const tracks: { id: TrackId; name: string; color: string }[] = [
    ...project.voices.map((v, i) => ({ id: v.source, name: v.name || v.source, color: colors[i % colors.length] })),
    { id: BGM_ID, name: 'BGM', color: '#B79CFF' },
    { id: MASTER_ID, name: 'マスター', color: '#E8EAED' },
  ]
  const track: TrackId = picked ?? tracks[0].id
  const comparing = usePlayhead(player, () => player.comparing)
  const voice = project.voices.find(v => v.source === track)
  const fx = trackEffects(project, track)
  const set = (list: Fx[], group: string) => onChange(withTrackEffects(project, track, gateBeforeComp(list)), group)
  const eqI = idxOf(fx, 'eq'), gateI = idxOf(fx, 'gate'), compI = idxOf(fx, 'compressor'), limI = idxOf(fx, 'limiter')
  const eq = eqI >= 0 ? fx[eqI] : null
  const color = tracks.find(t => t.id === track)?.color ?? '#fff'

  /** type のエフェクトを変える（なければ作る） */
  const put = (e: Fx, group: string) => set(putFx(fx, e), group)
  /** オン／オフ。なければ作ってオンにする */
  const toggle = (type: string, on: boolean) => {
    const i = idxOf(fx, type)
    put(i >= 0 ? { ...fx[i], enabled: on } : structuredClone(NEW_FX[type]), `en-${type}-${Date.now()}`)
  }
  const denoise = voice?.denoise as { atten_lim_db?: number | null } | null | undefined
  const dnLevel = !denoise ? 'none' : denoise.atten_lim_db ? 'mild' : 'strong'
  const setDenoise = (d: object | null) => voice && onChange({ ...project, voices: project.voices.map(v => (v === voice ? { ...v, denoise: d } : v)) }, `dn-${Date.now()}`)
  const out = project.output as { loudness_lufs?: number | null; true_peak_dbtp?: number }
  const order = eqFirst(fx)

  return (
    <div className="fxdash">
      <div className="fxbar">
        <div className="tabs fxtracks" role="group" aria-label="トラック" title="選んだトラックだけを鳴らす（マスターは全部）">
          {tracks.map(t => (
            <button key={t.id} aria-pressed={track === t.id} onClick={() => setTrack(t.id)}>
              <span className="dot" style={{ background: t.color }} />{t.name}
            </button>
          ))}
        </div>
        <div className="tabs" role="group" aria-label="聴き比べ" title="処理前＝エフェクトもノイズ除去もかけない音（フェーダーの分の音量はそろえる）">
          <button aria-pressed={comparing} onClick={() => void player.setCompare(true)}>処理前</button>
          <button aria-pressed={!comparing} onClick={() => void player.setCompare(false)}>処理後</button>
        </div>
        {voice && (
          <div className="fxgroup" title="AI のノイズ除去（DeepFilterNet）。変えると作り直す（1トラック約1分）">
            <span className="fxlabel">ノイズ除去</span>
            <div className="tabs" role="group" aria-label="ノイズ除去の強さ">
              <button aria-pressed={dnLevel === 'none'} onClick={() => setDenoise(null)}>なし</button>
              <button aria-pressed={dnLevel === 'mild'} onClick={() => setDenoise({ method: 'deepfilternet', atten_lim_db: 12 })}>控えめ</button>
              <button aria-pressed={dnLevel === 'strong'} onClick={() => setDenoise({ method: 'deepfilternet', atten_lim_db: null })}>強</button>
            </div>
            {denoiseBusy[track] && <span className="status busy">作り直し中…</span>}
          </div>
        )}
        {track === MASTER_ID && (
          <div className="fxgroup">
            <span className="fxlabel">書き出しの大きさ</span>
            <select value={out.loudness_lufs == null ? 'none' : String(out.loudness_lufs)} aria-label="そろえる大きさ"
              onChange={e => onChange({ ...project, output: { ...project.output, loudness_lufs: e.target.value === 'none' ? null : +e.target.value } }, `lufs-${Date.now()}`)}>
              <option value="-14">−14 LUFS（Spotify）</option>
              <option value="-16">−16 LUFS（Apple）</option>
              <option value="none">そろえない</option>
              {out.loudness_lufs != null && out.loudness_lufs !== -14 && out.loudness_lufs !== -16 && <option value={String(out.loudness_lufs)}>{out.loudness_lufs} LUFS</option>}
            </select>
            <span className="fxlabel">ピーク上限</span>
            <input type="number" step={0.1} value={out.true_peak_dbtp ?? -1} aria-label="ピークの上限（dBTP）" className="numsm"
              onChange={e => e.target.value !== '' && onChange({ ...project, output: { ...project.output, true_peak_dbtp: +e.target.value } }, 'tp')} />
            <span className="fxlabel">dBTP</span>
          </div>
        )}
        <div className="fxgroup" title="EQ とダイナミクスのどちらを先にかけるか">
          <span className="fxlabel">順番</span>
          <div className="tabs" role="group" aria-label="かかる順番">
            <button aria-pressed={order} onClick={() => set(setOrder(fx, true), `order-${Date.now()}`)}>EQ → ダイナミクス</button>
            <button aria-pressed={!order} onClick={() => set(setOrder(fx, false), `order-${Date.now()}`)}>ダイナミクス → EQ</button>
          </div>
        </div>
      </div>

      <div className="fxgrid">
        <section className="fxpanel area-eq">
          <div className="fxhead">
            <h2>EQ</h2>
            <label className="onoff"><input type="checkbox" checked={!!eq && eq.enabled !== false} onChange={e => toggle('eq', e.target.checked)} />オン</label>
          </div>
          {eq ? <EqEditor fx={eq} fs={project.sample_rate} player={player} track={track} onChange={(e, g) => put(e, g)} />
            : <div className="hint">オンにすると、平らな EQ（5 バンド）から始めます</div>}
        </section>

        <section className="fxpanel area-dyn">
          <div className="fxhead"><h2>ダイナミクス</h2><span className="hint">ゲート（小さい音を下げる）＋コンプ（大きい音を抑える）</span></div>
          <DynEditor gate={gateI >= 0 ? fx[gateI] : null} comp={compI >= 0 ? fx[compI] : null} gateI={gateI} compI={compI}
            player={player} track={track} onPut={put} onToggle={toggle} />
          {track === MASTER_ID && (
            <div className="dyncol">
              <label className="onoff"><input type="checkbox" checked={limI >= 0 && fx[limI].enabled !== false} onChange={e => toggle('limiter', e.target.checked)} /><b>リミッター</b></label>
              {limI >= 0 && <Params fx={fx[limI]} onChange={(e, g) => put(e, g)}
                rows={[['ceiling_db', '上限', -12, 0, 0.1, 'dB'], ['release_ms', 'リリース', 5, 500, 1, 'ms']]} />}
            </div>
          )}
        </section>

        <FaderPanel id={track} player={player} color={color} db={faderDb(fx)} gainDb={voice?.gain_db}
          onChange={db => set(withFader(fx, db) as Fx[], 'fader')} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- フェーダーとメーター

const F_LO = -30, F_HI = 12

function FaderPanel({ id, player, color, db, gainDb, onChange }: {
  id: TrackId; player: Player; color: string; db: number; gainDb?: number; onChange: (db: number) => void
}) {
  const bar = useRef<HTMLDivElement>(null), hold = useRef<HTMLDivElement>(null), peakText = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0, level = -Infinity, peak = -Infinity, at = 0
    const pct = (d: number) => Math.max(0, Math.min(100, ((d + 60) / 60) * 100))
    const loop = (now: number) => {
      const d = player.playing ? player.levels()[id] ?? -Infinity : -Infinity
      level = Math.max(d, level - 1.2)
      if (d >= peak || now - at > 1500) { peak = d; at = now }
      if (bar.current) { bar.current.style.height = `${pct(level)}%`; bar.current.style.background = level > -1 ? '#FF6B6B' : level > -9 ? '#E8C547' : '#5FD39A' }
      if (hold.current) { hold.current.style.bottom = `${pct(peak)}%`; hold.current.style.opacity = peak > -60 ? '1' : '0' }
      if (peakText.current) peakText.current.textContent = peak > -60 ? peak.toFixed(1) : '−∞'
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [id, player])
  return (
    <section className="fxpanel area-fader">
      <div className="fxhead"><h2>フェーダー</h2></div>
      <div className="fadercol">
        <div className="meter big" aria-hidden="true"><div ref={bar} className="mbar" /><div ref={hold} className="mhold" /></div>
        <input className="fader big" type="range" min={F_LO} max={F_HI} step={0.1} value={db} aria-label="フェーダー（dB）"
          title="ダブルクリックで 0 dB" style={{ accentColor: color }}
          onChange={e => onChange(+e.target.value)} onDoubleClick={() => onChange(0)} />
      </div>
      <input type="number" step={0.1} min={F_LO} max={F_HI} value={db} aria-label="フェーダーの値（dB）" className="numsm wide"
        onChange={e => e.target.value !== '' && onChange(Math.max(F_LO, Math.min(F_HI, +e.target.value)))} />
      <div className="hint">ピーク <span ref={peakText} className="mono">−∞</span> dB</div>
      {gainDb != null && <div className="hint" title="声の大きさを測って自動で決めた値（ノイズ除去より前にかかる）">声の音量（自動）{gainDb > 0 ? '+' : ''}{gainDb.toFixed(1)} dB</div>}
    </section>
  )
}

// ---------------------------------------------------------------- 数値の行（スライダー＋数値）

type Row = [key: string, label: string, min: number, max: number, step: number, unit: string, log?: boolean]

function Params({ fx, rows, onChange }: { fx: Fx; rows: Row[]; onChange: (e: Fx, group: string) => void }) {
  return (
    <div className="params">
      {rows.map(([k, label, min, max, step, unit, log]) => {
        const v = Number(fx[k] ?? 0)
        const toPos = (x: number) => (log ? Math.log(x / min) / Math.log(max / min) : (x - min) / (max - min)) * 1000
        const fromPos = (p: number) => {
          const u = p / 1000
          const x = log ? min * Math.pow(max / min, u) : min + u * (max - min)
          return Math.round(x / step) * step
        }
        return (
          <label key={k} className="prow">
            <span>{label}</span>
            <input type="range" min={0} max={1000} value={toPos(Math.min(max, Math.max(min, v)))} aria-label={label}
              onChange={e => onChange({ ...fx, [k]: +fromPos(+e.target.value).toFixed(3) }, `p-${k}`)} />
            <input type="number" step={step} value={+v.toFixed(3)} aria-label={`${label}（${unit}）`}
              onChange={e => e.target.value !== '' && onChange({ ...fx, [k]: +e.target.value }, `p-${k}`)} />
            <span className="unit">{unit}</span>
          </label>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- EQ

const F_MIN = 20, F_MAX = 20000, DB_RANGE = 24
const xOfF = (f: number, w: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w
const fOfX = (x: number, w: number) => F_MIN * Math.pow(F_MAX / F_MIN, Math.min(1, Math.max(0, x / w)))
const yOfDb = (db: number, h: number) => h / 2 - (db / DB_RANGE) * (h / 2 - 8)
const dbOfY = (y: number, h: number) => ((h / 2 - y) / (h / 2 - 8)) * DB_RANGE
const fmtF = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`)
const hasGain = (t: string) => t === 'bell' || t === 'lowshelf' || t === 'highshelf'

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

function EqEditor({ fx, fs, player, track, onChange }: { fx: Fx; fs: number; player: Player; track: TrackId; onChange: (e: Fx, g: string) => void }) {
  const bands = (fx.bands ?? []) as Band[]
  const [box, { w, h }] = useSize<HTMLDivElement>()
  const curve = useRef<HTMLCanvasElement>(null)
  const spec = useRef<HTMLCanvasElement>(null)
  const [active, setActive] = useState<number | null>(null)
  const setBand = (i: number, b: Band, g: string) => onChange({ ...fx, bands: bands.map((x, k) => (k === i ? b : x)) }, g)

  // カーブ（バンドごとの色の線と、合計の白い線）
  useEffect(() => {
    const cv = curve.current
    if (!cv || !w) return
    const dpr = devicePixelRatio || 1
    cv.width = w * dpr; cv.height = h * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h)
    // 目盛り
    g.strokeStyle = '#2A2E36'; g.lineWidth = 1
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = xOfF(f, w); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke() }
    for (const db of [-12, 12]) { const y = yOfDb(db, h); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke() }
    g.strokeStyle = '#4A4F5A'; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke()
    g.fillStyle = '#6B7280'; g.font = '10px sans-serif'
    for (const f of [100, 1000, 10000]) g.fillText(fmtF(f), xOfF(f, w) + 3, h - 4)
    for (const db of [-12, 0, 12]) g.fillText(`${db > 0 ? '+' : ''}${db}`, 3, yOfDb(db, h) - 3)
    const freqs = logFreqs(Math.max(64, Math.floor(w / 2)), F_MIN, F_MAX)
    const r = eqResponseDb(bands as never, fs, freqs)
    const line = (vals: number[], color: string, width: number) => {
      g.strokeStyle = color; g.lineWidth = width; g.beginPath()
      vals.forEach((db, i) => { const x = xOfF(freqs[i], w), y = yOfDb(Math.max(-DB_RANGE - 6, Math.min(DB_RANGE + 6, db)), h); if (i) g.lineTo(x, y); else g.moveTo(x, y) })
      g.stroke()
    }
    r.perBand.forEach((vals, i) => { if (bands[i]?.enabled !== false) line(vals, BAND_COLORS[i % BAND_COLORS.length] + (active === i ? '' : 'AA'), active === i ? 2 : 1.2) })
    line(r.total, fx.enabled === false ? '#6B7280' : '#FFFFFF', 2.5)
  }, [bands, fs, w, h, active, fx.enabled])

  // 処理前（灰色の面）と処理後（青い線）の音の成分。再生中だけ動く
  useEffect(() => {
    let raf = 0
    const chain = player.chain(track)
    const pre = new Float32Array(chain?.pre.frequencyBinCount ?? 2048), post = new Float32Array(pre.length)
    const draw = () => {
      const cv = spec.current
      if (cv && w && chain) {
        const dpr = devicePixelRatio || 1
        if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr }
        const g = cv.getContext('2d')!
        g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h)
        if (player.playing) {
          chain.pre.getFloatFrequencyData(pre); chain.post.getFloatFrequencyData(post)
          const nyq = player.ctx.sampleRate / 2
          const yOf = (db: number) => h - Math.max(0, Math.min(1, (db + 100) / 80)) * h // −100〜−20 dB
          const path = (arr: Float32Array) => {
            g.beginPath()
            for (let x = 0; x <= w; x += 2) {
              const f = fOfX(x, w)
              const i = Math.min(arr.length - 1, Math.round((f / nyq) * arr.length))
              const y = yOf(arr[i]); if (x) g.lineTo(x, y); else g.moveTo(x, y)
            }
          }
          path(pre); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = '#2C313A'; g.fill()
          path(post); g.strokeStyle = 'rgba(106,167,255,0.8)'; g.lineWidth = 1.5; g.stroke()
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [player, track, w, h])

  // 点のドラッグ：左右＝周波数、上下＝量（ハイパス・ローパスは左右だけ）、Alt＋ドラッグ＝幅（Q）
  const startDrag = (i: number) => (ev: React.PointerEvent) => {
    ev.preventDefault(); ev.stopPropagation()
    setActive(i)
    const el = ev.currentTarget as HTMLElement
    el.setPointerCapture(ev.pointerId)
    const rect = box.current!.getBoundingClientRect()
    const b0 = bands[i], y0 = ev.clientY, q0 = b0.q ?? 1
    const move = (m: PointerEvent) => {
      if (m.altKey && b0.type === 'bell') {
        setBand(i, { ...b0, q: +Math.min(10, Math.max(0.1, q0 * Math.pow(2, (y0 - m.clientY) / 60))).toFixed(2) }, `eq-${i}`)
        return
      }
      const f = Math.round(fOfX(m.clientX - rect.left, rect.width))
      const nb: Band = { ...b0, freq: f }
      if (hasGain(b0.type)) nb.gain_db = +Math.max(-DB_RANGE, Math.min(DB_RANGE, dbOfY(m.clientY - rect.top, rect.height))).toFixed(1)
      setBand(i, nb, `eq-${i}`)
    }
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up)
  }

  const r = w ? eqResponseDb(bands as never, fs, bands.map(b => b.freq)) : null
  return (
    <div className="eq">
      <div className="eqgraph" ref={box}>
        <canvas ref={spec} />
        <canvas ref={curve} />
        {w > 0 && bands.map((b, i) => b.enabled === false ? null : (
          <button key={i} className={`eqnode${active === i ? ' sel' : ''}`}
            style={{ left: xOfF(b.freq, w), top: yOfDb(hasGain(b.type) ? (r?.perBand[i]?.[i] ?? b.gain_db ?? 0) : 0, h), borderColor: BAND_COLORS[i % BAND_COLORS.length] }}
            aria-label={`バンド${i + 1}：${fmtF(b.freq)}${hasGain(b.type) ? ` ${b.gain_db ?? 0} dB` : ''}`}
            title={`${i + 1}：${fmtF(b.freq)}${hasGain(b.type) ? ` ・ ${(b.gain_db ?? 0).toFixed(1)} dB` : ''}${b.type === 'bell' ? ` ・ Q ${b.q ?? 1}` : ''}`}
            onPointerDown={startDrag(i)}
            onDoubleClick={() => hasGain(b.type) && setBand(i, { ...b, gain_db: 0 }, `eq0-${Date.now()}`)}
            onWheel={e => { if (b.type === 'bell') setBand(i, { ...b, q: +Math.min(10, Math.max(0.1, (b.q ?? 1) * Math.pow(2, -e.deltaY / 300))).toFixed(2) }, `eq-q-${i}`) }}>
            {i + 1}
          </button>
        ))}
      </div>
      <details className="bandsbox">
        <summary>バンドの数値</summary>
      <div className="bands">
        {bands.map((b, i) => (
          <div key={i} className={`band${active === i ? ' sel' : ''}${b.enabled === false ? ' off' : ''}`} onClick={() => setActive(i)}>
            <div className="bandhead">
              <span className="bandno" style={{ background: BAND_COLORS[i % BAND_COLORS.length] }}>{i + 1}</span>
              <select value={b.type} aria-label={`バンド${i + 1}の種類`} onChange={e => setBand(i, { ...b, type: e.target.value }, `bt-${Date.now()}`)}>
                {BAND_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <input type="checkbox" checked={b.enabled !== false} aria-label={`バンド${i + 1}をオン`} title="オン／オフ"
                onChange={e => setBand(i, { ...b, enabled: e.target.checked }, `ben-${Date.now()}`)} />
              <button className="btn icon sm" aria-label={`バンド${i + 1}を削除`} title="削除"
                onClick={ev => { ev.stopPropagation(); onChange({ ...fx, bands: bands.filter((_, k) => k !== i) }, `bdel-${Date.now()}`); setActive(null) }}>×</button>
            </div>
            <label>周波数<input type="number" value={b.freq} step={1} min={20} max={20000}
              onChange={e => e.target.value !== '' && setBand(i, { ...b, freq: +e.target.value }, `bf-${i}`)} /><span>Hz</span></label>
            {hasGain(b.type) && <label>量<input type="number" value={b.gain_db ?? 0} step={0.1}
              onChange={e => e.target.value !== '' && setBand(i, { ...b, gain_db: +e.target.value }, `bg-${i}`)} /><span>dB</span></label>}
            {b.type === 'bell' && <label>Q<input type="number" value={b.q ?? 1} step={0.1} min={0.1} max={10}
              onChange={e => e.target.value !== '' && setBand(i, { ...b, q: +e.target.value }, `bq-${i}`)} /><span /></label>}
          </div>
        ))}
        {bands.length < 8 && <button className="btn" onClick={() => onChange({ ...fx, bands: [...bands, { type: 'bell', freq: 1000, gain_db: 0, q: 1 }] }, `badd-${Date.now()}`)}>＋ バンド</button>}
      </div>
      </details>
    </div>
  )
}


// ---------------------------------------------------------------- ダイナミクス（ゲート＋コンプ）

const L_MIN = -60 // グラフの左端・下端（dB）
const GATE_COLOR = '#6AA7FF', COMP_COLOR = '#C6E36A'

function DynEditor({ gate, comp, gateI, compI, player, track, onPut, onToggle }: {
  gate: Fx | null; comp: Fx | null; gateI: number; compI: number; player: Player; track: TrackId
  onPut: (e: Fx, g: string) => void; onToggle: (type: string, on: boolean) => void
}) {
  const [box, { w, h }] = useSize<HTMLDivElement>()
  const graph = useRef<HTMLCanvasElement>(null)
  const hist = useRef<HTMLCanvasElement>(null)
  const dot = useRef<HTMLDivElement>(null)
  const gr = useRef<HTMLDivElement>(null)
  const grText = useRef<HTMLSpanElement>(null)
  const gOn = !!gate && gate.enabled !== false, cOn = !!comp && comp.enabled !== false
  const gThr = Number(gate?.threshold_db ?? -50), gRange = Number(gate?.range_db ?? 0)
  const cThr = Number(comp?.threshold_db ?? -20), ratio = Number(comp?.ratio ?? 1), knee = Number(comp?.knee ?? 0)
  const makeup = cOn ? Number(comp?.makeup_db ?? 0) : 0
  // 入る音 → 出る音（オンのものだけ。ゲート → コンプの順）
  const outOf = (l: number) => {
    let y = l
    if (gOn) y += gateStaticGainDb(l, gThr, gRange)
    if (cOn) y += compStaticGainDb(y, cThr, ratio, knee) + makeup
    return y
  }
  const px = (db: number, size: number) => ((db - L_MIN) / -L_MIN) * size
  const dbAt = (p: number, size: number) => L_MIN + (p / size) * -L_MIN

  useEffect(() => {
    const cv = graph.current
    if (!cv || !w) return
    const dpr = devicePixelRatio || 1
    cv.width = w * dpr; cv.height = h * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h)
    g.strokeStyle = '#2A2E36'; g.lineWidth = 1
    for (let d = -50; d < 0; d += 10) { const x = px(d, w), y = h - px(d, h); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.moveTo(0, y); g.lineTo(w, y); g.stroke() }
    g.strokeStyle = '#3A404B'; g.beginPath(); g.moveTo(0, h); g.lineTo(w, 0); g.stroke()
    // しきい値の縦線
    g.setLineDash([4, 4])
    if (gOn) { g.strokeStyle = GATE_COLOR + '88'; g.beginPath(); g.moveTo(px(gThr, w), 0); g.lineTo(px(gThr, w), h); g.stroke() }
    if (cOn) { g.strokeStyle = COMP_COLOR + '88'; g.beginPath(); g.moveTo(px(cThr, w), 0); g.lineTo(px(cThr, w), h); g.stroke() }
    g.setLineDash([])
    g.strokeStyle = gOn || cOn ? '#FFFFFF' : '#6B7280'; g.lineWidth = 3; g.beginPath()
    for (let x = 0; x <= w; x += 2) {
      const y = h - px(Math.max(L_MIN - 20, outOf(dbAt(x, w))), h)
      if (x) g.lineTo(x, y); else g.moveTo(x, y)
    }
    g.stroke()
    g.fillStyle = '#6B7280'; g.font = '10px sans-serif'
    g.fillText('入る音（dB）→', w - 84, h - 4); g.fillText('出る音', 4, 12)
  }, [w, h, gOn, cOn, gThr, gRange, cThr, ratio, knee, makeup]) // eslint-disable-line react-hooks/exhaustive-deps

  // 再生中：今の位置・下げた量（ゲートとコンプの合計）・直近 6 秒の音量の動き
  useEffect(() => {
    let raf = 0
    const N = 360, ins = new Float32Array(N).fill(L_MIN), outs = new Float32Array(N).fill(L_MIN), grs = new Float32Array(N)
    let head = 0, last = 0
    const loop = (now: number) => {
      const chain = player.chain(track)
      const mg = gOn && gateI >= 0 ? chain?.meters(gateI) : undefined
      const mc = cOn && compI >= 0 ? chain?.meters(compI) : undefined
      const playing = player.playing && !!(mg || mc)
      const first = (gateI >= 0 && compI >= 0 ? (gateI < compI ? mg : mc) : mg ?? mc)
      const lastM = (gateI >= 0 && compI >= 0 ? (gateI < compI ? mc : mg) : mc ?? mg)
      const inDb = playing && first ? Math.max(L_MIN, first.inDb) : L_MIN
      const gdb = playing ? Math.min(0, (mg?.gainDb ?? 0) + (mc?.gainDb ?? 0)) : 0
      const outDb = playing && lastM ? Math.max(L_MIN, lastM.outDb) : L_MIN
      if (dot.current) {
        dot.current.style.opacity = playing && inDb > L_MIN ? '1' : '0'
        dot.current.style.left = `${px(inDb, w)}px`
        dot.current.style.top = `${h - px(Math.max(L_MIN, inDb + gdb + makeup), h)}px`
      }
      if (gr.current) gr.current.style.height = `${Math.min(100, (-gdb / 30) * 100)}%`
      if (grText.current) grText.current.textContent = `${(-gdb).toFixed(1)} dB`
      if (now - last > 1000 / 60) {
        last = now
        ins[head] = inDb; outs[head] = outDb; grs[head] = gdb; head = (head + 1) % N
        const cv = hist.current
        if (cv) {
          const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1
          if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr }
          const g = cv.getContext('2d')!
          g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H)
          const xi = (k: number) => (k / (N - 1)) * W, yl = (db: number) => H - ((db - L_MIN) / -L_MIN) * H
          g.fillStyle = '#7A4E24'; g.beginPath(); g.moveTo(0, 0)
          for (let k = 0; k < N; k++) g.lineTo(xi(k), Math.min(H, (-grs[(head + k) % N] / 30) * H))
          g.lineTo(W, 0); g.closePath(); g.fill()
          g.setLineDash([6, 4]); g.lineWidth = 1
          if (gOn) { g.strokeStyle = GATE_COLOR; g.beginPath(); g.moveTo(0, yl(gThr)); g.lineTo(W, yl(gThr)); g.stroke() }
          if (cOn) { g.strokeStyle = COMP_COLOR; g.beginPath(); g.moveTo(0, yl(cThr)); g.lineTo(W, yl(cThr)); g.stroke() }
          g.setLineDash([])
          const line = (arr: Float32Array, color: string, lw: number) => {
            g.strokeStyle = color; g.lineWidth = lw; g.beginPath()
            for (let k = 0; k < N; k++) { const y = yl(arr[(head + k) % N]); if (k) g.lineTo(xi(k), y); else g.moveTo(xi(k), y) }
            g.stroke()
          }
          line(ins, '#8B939E', 1.2); line(outs, '#5FD39A', 1.8)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [player, track, gateI, compI, gOn, cOn, w, h, gThr, cThr, makeup]) // eslint-disable-line react-hooks/exhaustive-deps

  // ドラッグ：□＝しきい値（左右）、○＝コンプのレシオ（上下）
  const drag = (what: 'gthr' | 'cthr' | 'ratio') => (ev: React.PointerEvent) => {
    ev.preventDefault(); ev.stopPropagation()
    const el = ev.currentTarget as HTMLElement
    el.setPointerCapture(ev.pointerId)
    const rect = box.current!.getBoundingClientRect()
    const move = (m: PointerEvent) => {
      const x = +Math.min(0, Math.max(L_MIN, dbAt(m.clientX - rect.left, rect.width))).toFixed(1)
      if (what === 'gthr' && gate) onPut({ ...gate, threshold_db: x }, 'd-gthr')
      else if (what === 'cthr' && comp) onPut({ ...comp, threshold_db: x }, 'd-cthr')
      else if (what === 'ratio' && comp) {
        const out = dbAt(rect.height - (m.clientY - rect.top), rect.height) - makeup
        const over = -cThr, outOver = Math.max(0.01, out - cThr)
        onPut({ ...comp, ratio: +Math.min(20, Math.max(1, over / outOver)).toFixed(1) }, 'd-ratio')
      }
    }
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up)
  }

  return (
    <div className="dyn">
      <div className="dyntop">
        <div className="dyngraph" ref={box}>
          <canvas ref={graph} />
          {w > 0 && <>
            {gOn && <div className="dynhandle sq" style={{ left: px(gThr, w), top: h - px(outOf(gThr), h), borderColor: GATE_COLOR }}
              title={`ゲートのしきい値 ${gThr} dB`} onPointerDown={drag('gthr')} />}
            {cOn && <div className="dynhandle sq" style={{ left: px(cThr, w), top: h - px(outOf(cThr), h), borderColor: COMP_COLOR }}
              title={`コンプのしきい値 ${cThr} dB`} onPointerDown={drag('cthr')} />}
            {cOn && <div className="dynhandle ci" style={{ left: w, top: h - px(outOf(0), h), borderColor: COMP_COLOR }}
              title={`レシオ ${ratio}:1`} onPointerDown={drag('ratio')} />}
            <div ref={dot} className="dyndot" />
          </>}
        </div>
        <div className="grmeter" aria-label="下げた量">
          <div className="grbar"><div ref={gr} /></div>
          <span ref={grText} className="mono">0.0 dB</span>
          <span className="hint">下げた量</span>
        </div>
        <div className="dyncols">
          <div className="dyncol">
            <label className="onoff"><input type="checkbox" checked={gOn} onChange={e => onToggle('gate', e.target.checked)} />
              <b style={{ color: GATE_COLOR }}>ゲート</b></label>
            {gate && <Params fx={gate} onChange={onPut} rows={[
              ['threshold_db', 'しきい値', -80, 0, 0.5, 'dB'], ['range_db', '下げる量', 0, 80, 1, 'dB'],
              ['attack_ms', 'アタック', 0.1, 100, 0.1, 'ms', true], ['hold_ms', 'ホールド', 0, 500, 1, 'ms'], ['release_ms', 'リリース', 5, 2000, 1, 'ms', true]]} />}
          </div>
          <div className="dyncol">
            <label className="onoff"><input type="checkbox" checked={cOn} onChange={e => onToggle('compressor', e.target.checked)} />
              <b style={{ color: COMP_COLOR }}>コンプ</b></label>
            {comp && <Params fx={comp} onChange={onPut} rows={[
              ['threshold_db', 'しきい値', -60, 0, 0.5, 'dB'], ['ratio', 'レシオ', 1, 20, 0.1, ':1', true], ['knee', 'ニー', 0, 100, 1, ''],
              ['attack_ms', 'アタック', 0.1, 200, 0.1, 'ms', true], ['release_ms', 'リリース', 5, 2000, 1, 'ms', true],
              ['makeup_db', 'メイクアップ', -12, 24, 0.1, 'dB'], ['dry_mix', '原音を混ぜる', 0, 1, 0.01, '']]} />}
          </div>
        </div>
      </div>
      <div className="dynhist">
        <canvas ref={hist} />
        <div className="hint dynlegend"><span style={{ color: '#8B939E' }}>― 入る音</span><span style={{ color: '#5FD39A' }}>― 出る音</span><span style={{ color: '#C08A50' }}>■ 下げた量</span><span>直近 6 秒</span></div>
      </div>
    </div>
  )
}
