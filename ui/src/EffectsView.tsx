// ③④ エフェクト：トラックを選び、エフェクトを上から順に並べる（オン／オフ・追加・削除・並べ替え）。
// 選んだエフェクトを右で調整する。EQ は線の上の点、コンプはグラフの □ ○ をドラッグ。
// 再生中は、処理前・処理後の音の成分（EQ）や、下げた量・音量の動き（コンプ・ゲート）がその場で動く。
import { useEffect, useRef, useState } from 'react'
import { compStaticGainDb, eqResponseDb, gateStaticGainDb, logFreqs } from './dsp'
import { BGM_ID, MASTER_ID, type Player } from './player'
import { usePlayhead } from './playhead'
import type { Project } from './types'

type Fx = { type: string; enabled?: boolean; [k: string]: any } // eslint-disable-line @typescript-eslint/no-explicit-any
type Band = { type: string; freq: number; gain_db?: number; q?: number; enabled?: boolean }

const NAMES: Record<string, string> = { eq: 'EQ', compressor: 'コンプレッサー', gate: 'ノイズゲート', gain: '音量（フェーダー）', limiter: 'リミッター' }
const BAND_COLORS = ['#FF8A8A', '#F2A65A', '#E5D35A', '#6DD08A', '#5FD3E6', '#B79CFF', '#E58AE0', '#9BB0C8']
const BAND_TYPES: [string, string][] = [['highpass', 'ハイパス'], ['lowshelf', 'ローシェルフ'], ['bell', 'ベル'], ['highshelf', 'ハイシェルフ'], ['lowpass', 'ローパス']]

const NEW_FX: Record<string, Fx> = {
  eq: { type: 'eq', bands: [
    { type: 'highpass', freq: 80 }, { type: 'lowshelf', freq: 200, gain_db: 0 },
    { type: 'bell', freq: 1000, gain_db: 0, q: 1 }, { type: 'bell', freq: 3000, gain_db: 0, q: 1 }, { type: 'highshelf', freq: 6000, gain_db: 0 }] },
  compressor: { type: 'compressor', threshold_db: -20, ratio: 3, knee: 30, attack_ms: 5, release_ms: 100, makeup_db: 0, dry_mix: 0 },
  gate: { type: 'gate', threshold_db: -50, range_db: 20, attack_ms: 1, hold_ms: 50, release_ms: 150 },
  gain: { type: 'gain', db: 0 },
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

function summary(e: Fx): string {
  switch (e.type) {
    case 'eq': return `${(e.bands as Band[]).filter(b => b.enabled !== false).length} バンド`
    case 'compressor': return `${e.threshold_db} dB ・ ${e.ratio}:1`
    case 'gate': return `${e.threshold_db} dB ・ −${e.range_db} dB`
    case 'gain': return `${e.db > 0 ? '+' : ''}${Number(e.db).toFixed(1)} dB`
    case 'limiter': return `${e.ceiling_db ?? -1} dB`
    default: return ''
  }
}

interface Props {
  project: Project; player: Player; colors: string[]
  onChange: (p: Project, group?: string) => void
  denoiseBusy: Record<string, boolean>
}

export function EffectsView({ project, player, colors, onChange, denoiseBusy }: Props) {
  const tracks: { id: TrackId; name: string; color: string }[] = [
    ...project.voices.map((v, i) => ({ id: v.source, name: v.name || v.source, color: colors[i % colors.length] })),
    { id: BGM_ID, name: 'BGM', color: '#B79CFF' },
    { id: MASTER_ID, name: 'マスター', color: '#E8EAED' },
  ]
  const [track, setTrack] = useState<TrackId>(tracks[0].id)
  const [sel, setSel] = useState<number | 'denoise'>(0)
  const [adding, setAdding] = useState(false)
  const comparing = usePlayhead(player, () => player.comparing)
  const voice = project.voices.find(v => v.source === track)
  const fx = trackEffects(project, track)
  const set = (list: Fx[], group: string) => onChange(withTrackEffects(project, track, list), group)
  const setOne = (i: number, e: Fx, group: string) => set(fx.map((x, k) => (k === i ? e : x)), group)
  useEffect(() => { setSel(voice?.denoise !== undefined && fx.length === 0 ? 'denoise' : 0) }, [track]) // eslint-disable-line react-hooks/exhaustive-deps

  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= fx.length) return
    const list = [...fx];[list[i], list[j]] = [list[j], list[i]]
    set(list, `move-${Date.now()}`); setSel(j)
  }
  const selected = typeof sel === 'number' ? fx[sel] : undefined

  return (
    <div className="fxview">
      <aside className="fxlist">
        <div className="tabs fxtracks" role="group" aria-label="トラック">
          {tracks.map(t => (
            <button key={t.id} aria-pressed={track === t.id} onClick={() => setTrack(t.id)}>
              <span className="dot" style={{ background: t.color }} />{t.name}
            </button>
          ))}
        </div>
        <div className="tabs" role="group" aria-label="聴き比べ" title="処理前＝エフェクトもノイズ除去もかけない音">
          <button aria-pressed={comparing} onClick={() => void player.setCompare(true)}>処理前</button>
          <button aria-pressed={!comparing} onClick={() => void player.setCompare(false)}>処理後</button>
        </div>
        <ol className="fxitems">
          {voice && (
            <li className={`fxitem${sel === 'denoise' ? ' sel' : ''}`} onClick={() => setSel('denoise')}>
              <div className="fxname">ノイズ除去（AI）</div>
              <div className="fxsum">{denoiseBusy[track] ? '作り直し中…' : voice.denoise ? ((voice.denoise as { atten_lim_db?: number | null }).atten_lim_db ? '控えめ' : '強') : 'なし'}</div>
            </li>
          )}
          {fx.map((e, i) => (
            <li key={i} className={`fxitem${sel === i ? ' sel' : ''}${e.enabled === false ? ' off' : ''}`} onClick={() => setSel(i)}>
              <input type="checkbox" checked={e.enabled !== false} aria-label={`${NAMES[e.type] ?? e.type}をオン`} title="オン／オフ"
                onClick={ev => ev.stopPropagation()} onChange={ev => setOne(i, { ...e, enabled: ev.target.checked }, `en-${Date.now()}`)} />
              <div className="fxname">{NAMES[e.type] ?? e.type}</div>
              <div className="fxsum">{summary(e)}</div>
              <div className="fxbtns">
                <button className="btn icon sm" aria-label="上へ" title="上へ" disabled={i === 0} onClick={ev => { ev.stopPropagation(); move(i, -1) }}>↑</button>
                <button className="btn icon sm" aria-label="下へ" title="下へ" disabled={i === fx.length - 1} onClick={ev => { ev.stopPropagation(); move(i, 1) }}>↓</button>
                <button className="btn icon sm" aria-label="削除" title="削除" onClick={ev => { ev.stopPropagation(); set(fx.filter((_, k) => k !== i), `del-${Date.now()}`); setSel(Math.max(0, i - 1)) }}>×</button>
              </div>
            </li>
          ))}
        </ol>
        <div className="fxadd">
          <button className="btn" aria-expanded={adding} onClick={() => setAdding(a => !a)}>＋ エフェクトを追加</button>
          {adding && (
            <div className="fxmenu" role="menu">
              {Object.keys(NEW_FX).filter(k => k !== 'limiter' || track === MASTER_ID).map(k => (
                <button key={k} role="menuitem" onClick={() => {
                  // 新しいエフェクトは、フェーダー（gain）より前に入れる
                  const gi = fx.findIndex(e => e.type === 'gain')
                  const at = gi >= 0 && k !== 'gain' && k !== 'limiter' ? gi : fx.length
                  set([...fx.slice(0, at), structuredClone(NEW_FX[k]), ...fx.slice(at)], `add-${Date.now()}`)
                  setSel(at); setAdding(false)
                }}>{NAMES[k]}</button>
              ))}
            </div>
          )}
        </div>
        {voice && <div className="hint" title="声の大きさを測って自動で決めた値（ノイズ除去より前にかかる）">声の音量（自動） {voice.gain_db > 0 ? '+' : ''}{voice.gain_db.toFixed(1)} dB</div>}
      </aside>

      <main className="fxmain">
        {track === MASTER_ID && <MasterOutput project={project} onChange={onChange} />}
        {sel === 'denoise' && voice
          ? <DenoiseEditor denoise={voice.denoise as { atten_lim_db?: number | null } | null} busy={!!denoiseBusy[track]}
              onSet={d => onChange({ ...project, voices: project.voices.map(v => (v === voice ? { ...v, denoise: d } : v)) }, `dn-${Date.now()}`)}
              onCompare={() => void player.setCompare(!player.comparing)} comparing={comparing} />
          : selected ? (
            <section className="fxpanel">
              <div className="fxhead">
                <h2>{NAMES[selected.type] ?? selected.type}</h2>
                <label className="onoff"><input type="checkbox" checked={selected.enabled !== false}
                  onChange={ev => setOne(sel as number, { ...selected, enabled: ev.target.checked }, `en-${Date.now()}`)} />オン</label>
              </div>
              {selected.type === 'eq' && <EqEditor fx={selected} fs={project.sample_rate} player={player} track={track}
                onChange={(e, g) => setOne(sel as number, e, g)} />}
              {selected.type === 'compressor' && <DynEditor kind="comp" fx={selected} player={player} track={track} index={sel as number}
                onChange={(e, g) => setOne(sel as number, e, g)} />}
              {selected.type === 'gate' && <DynEditor kind="gate" fx={selected} player={player} track={track} index={sel as number}
                onChange={(e, g) => setOne(sel as number, e, g)} />}
              {selected.type === 'gain' && <Params fx={selected} onChange={(e, g) => setOne(sel as number, e, g)}
                rows={[['db', '音量', -30, 12, 0.1, 'dB']]} />}
              {selected.type === 'limiter' && <Params fx={selected} onChange={(e, g) => setOne(sel as number, e, g)}
                rows={[['ceiling_db', '上限', -12, 0, 0.1, 'dB'], ['release_ms', 'リリース', 5, 500, 1, 'ms']]} />}
            </section>
          ) : <div className="center">左の一覧からエフェクトを選ぶか、追加してください</div>}
      </main>
    </div>
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

// ---------------------------------------------------------------- ノイズ除去

function DenoiseEditor({ denoise, busy, onSet, onCompare, comparing }: {
  denoise: { atten_lim_db?: number | null } | null; busy: boolean
  onSet: (d: object | null) => void; onCompare: () => void; comparing: boolean
}) {
  const level = !denoise ? 'none' : denoise.atten_lim_db ? 'mild' : 'strong'
  return (
    <section className="fxpanel">
      <div className="fxhead"><h2>ノイズ除去（AI）</h2>{busy && <span className="status busy">作り直し中…（1トラック約1分）</span>}</div>
      <div className="tabs" role="group" aria-label="ノイズ除去の強さ" title="DeepFilterNet。変えると作り直して保存し、次からは使い回す">
        <button aria-pressed={level === 'none'} onClick={() => onSet(null)}>なし</button>
        <button aria-pressed={level === 'mild'} onClick={() => onSet({ method: 'deepfilternet', atten_lim_db: 12 })}>控えめ（12 dB）</button>
        <button aria-pressed={level === 'strong'} onClick={() => onSet({ method: 'deepfilternet', atten_lim_db: null })}>強</button>
      </div>
      <div><button className="btn" onClick={onCompare}>{comparing ? '処理後に戻す' : '処理前と聴き比べ'}</button></div>
    </section>
  )
}

// ---------------------------------------------------------------- マスターの書き出し設定

function MasterOutput({ project, onChange }: { project: Project; onChange: (p: Project, group?: string) => void }) {
  const out = project.output as { loudness_lufs?: number | null; true_peak_dbtp?: number }
  const lufs = out.loudness_lufs
  return (
    <section className="fxpanel compact">
      <div className="fxhead"><h2>書き出しの大きさ</h2></div>
      <div className="params">
        <label className="prow"><span>ラウドネス</span>
          <select value={lufs == null ? 'none' : String(lufs)} aria-label="そろえる大きさ"
            onChange={e => onChange({ ...project, output: { ...project.output, loudness_lufs: e.target.value === 'none' ? null : +e.target.value } }, `lufs-${Date.now()}`)}>
            <option value="-14">−14 LUFS（Spotify）</option>
            <option value="-16">−16 LUFS（Apple Podcasts）</option>
            <option value="none">そろえない</option>
            {lufs != null && lufs !== -14 && lufs !== -16 && <option value={String(lufs)}>{lufs} LUFS</option>}
          </select><span /></label>
        <label className="prow"><span>ピークの上限</span>
          <input type="range" min={-60} max={0} step={1} value={(out.true_peak_dbtp ?? -1) * 10} aria-label="ピークの上限"
            onChange={e => onChange({ ...project, output: { ...project.output, true_peak_dbtp: +e.target.value / 10 } }, 'tp')} />
          <input type="number" step={0.1} value={out.true_peak_dbtp ?? -1} aria-label="ピークの上限（dBTP）"
            onChange={e => e.target.value !== '' && onChange({ ...project, output: { ...project.output, true_peak_dbtp: +e.target.value } }, 'tp')} />
          <span className="unit">dBTP</span></label>
      </div>
    </section>
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
    </div>
  )
}

// ---------------------------------------------------------------- コンプ・ゲート

const L_MIN = -60 // グラフの左端・下端（dB）

function DynEditor({ kind, fx, player, track, index, onChange }: {
  kind: 'comp' | 'gate'; fx: Fx; player: Player; track: TrackId; index: number; onChange: (e: Fx, g: string) => void
}) {
  const [box, { w, h }] = useSize<HTMLDivElement>()
  const graph = useRef<HTMLCanvasElement>(null)
  const hist = useRef<HTMLCanvasElement>(null)
  const dot = useRef<HTMLDivElement>(null)
  const gr = useRef<HTMLDivElement>(null)
  const grText = useRef<HTMLSpanElement>(null)
  const thr = Number(fx.threshold_db), ratio = Number(fx.ratio ?? 1), knee = Number(fx.knee ?? 0), range = Number(fx.range_db ?? 0)
  const makeup = kind === 'comp' ? Number(fx.makeup_db ?? 0) : 0
  const outOf = (l: number) => l + (kind === 'comp' ? compStaticGainDb(l, thr, ratio, knee) + makeup : gateStaticGainDb(l, thr, range))
  const px = (db: number, size: number) => ((db - L_MIN) / -L_MIN) * size
  const dbAt = (p: number, size: number) => L_MIN + (p / size) * -L_MIN

  // 入る音と出る音の関係（線）
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
    g.strokeStyle = fx.enabled === false ? '#6B7280' : '#C6E36A'; g.lineWidth = 3; g.beginPath()
    for (let x = 0; x <= w; x += 2) {
      const l = dbAt(x, w), y = h - px(outOf(l), h)
      if (x) g.lineTo(x, y); else g.moveTo(x, y)
    }
    g.stroke()
    g.fillStyle = '#6B7280'; g.font = '10px sans-serif'
    g.fillText('入る音（dB）→', w - 84, h - 4); g.fillText('出る音', 4, 12)
  }, [w, h, thr, ratio, knee, range, makeup, kind, fx.enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // 再生中：今の位置（点）・下げた量・直近 6 秒の音量の動き
  useEffect(() => {
    let raf = 0
    const N = 360, ins = new Float32Array(N).fill(L_MIN), outs = new Float32Array(N).fill(L_MIN), grs = new Float32Array(N)
    let head = 0, last = 0
    const loop = (now: number) => {
      const m = player.chain(track)?.meters(index)
      const playing = player.playing
      const inDb = playing && m ? Math.max(L_MIN, m.inDb) : L_MIN
      const gdb = playing && m ? Math.min(0, m.gainDb) : 0
      const outDb = playing && m ? Math.max(L_MIN, m.outDb) : L_MIN
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
          g.setLineDash([6, 4]); g.strokeStyle = '#C6E36A'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, yl(thr)); g.lineTo(W, yl(thr)); g.stroke(); g.setLineDash([])
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
  }, [player, track, index, w, h, thr, makeup]) // eslint-disable-line react-hooks/exhaustive-deps

  // ドラッグ：□＝しきい値（左右）、○＝レシオ（上下、コンプだけ）、線の上で上下＝ニー（コンプ）／量（ゲート）
  const drag = (what: 'thr' | 'ratio' | 'knee') => (ev: React.PointerEvent) => {
    ev.preventDefault(); ev.stopPropagation()
    const el = ev.currentTarget as HTMLElement
    el.setPointerCapture(ev.pointerId)
    const rect = box.current!.getBoundingClientRect()
    const y0 = ev.clientY, k0 = knee, r0 = range
    const move = (m: PointerEvent) => {
      if (what === 'thr') onChange({ ...fx, threshold_db: +Math.min(0, Math.max(L_MIN, dbAt(m.clientX - rect.left, rect.width))).toFixed(1) }, 'd-thr')
      else if (what === 'ratio') {
        // 右端（入る音 0 dB）での出る音の高さからレシオを逆算
        const out = dbAt(rect.height - (m.clientY - rect.top), rect.height) - makeup
        const over = -thr, outOver = Math.max(0.01, out - thr)
        onChange({ ...fx, ratio: +Math.min(20, Math.max(1, over / outOver)).toFixed(1) }, 'd-ratio')
      } else if (kind === 'comp') onChange({ ...fx, knee: Math.round(Math.min(100, Math.max(0, k0 + (y0 - m.clientY) / 2))) }, 'd-knee')
      else onChange({ ...fx, range_db: Math.round(Math.min(80, Math.max(0, r0 - (y0 - m.clientY) / 3))) }, 'd-range')
    }
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up)
  }

  const rows: Row[] = kind === 'comp'
    ? [['threshold_db', 'しきい値', -60, 0, 0.5, 'dB'], ['ratio', 'レシオ', 1, 20, 0.1, ':1', true], ['knee', 'ニー', 0, 100, 1, ''],
       ['attack_ms', 'アタック', 0.1, 200, 0.1, 'ms', true], ['release_ms', 'リリース', 5, 2000, 1, 'ms', true],
       ['makeup_db', 'メイクアップ', -12, 24, 0.1, 'dB'], ['dry_mix', '原音を混ぜる', 0, 1, 0.01, '']]
    : [['threshold_db', 'しきい値', -80, 0, 0.5, 'dB'], ['range_db', '下げる量', 0, 80, 1, 'dB'],
       ['attack_ms', 'アタック', 0.1, 100, 0.1, 'ms', true], ['hold_ms', 'ホールド', 0, 500, 1, 'ms'], ['release_ms', 'リリース', 5, 2000, 1, 'ms', true]]

  const endY = h - px(outOf(0), h)
  return (
    <div className="dyn">
      <div className="dyntop">
        <div className="dyngraph" ref={box} onPointerDown={drag(kind === 'comp' ? 'knee' : 'knee')}
          title={kind === 'comp' ? '線の上で上下にドラッグ：ニー' : '上下にドラッグ：下げる量'}>
          <canvas ref={graph} />
          {w > 0 && <>
            <div className="dynhandle sq" style={{ left: px(thr, w), top: h - px(outOf(thr), h) }} title={`しきい値 ${thr} dB`} onPointerDown={drag('thr')} />
            {kind === 'comp' && <div className="dynhandle ci" style={{ left: w, top: endY }} title={`レシオ ${ratio}:1`} onPointerDown={drag('ratio')} />}
            <div ref={dot} className="dyndot" />
          </>}
        </div>
        <div className="grmeter" aria-label="下げた量">
          <div className="grbar"><div ref={gr} /></div>
          <span ref={grText} className="mono">0.0 dB</span>
          <span className="hint">下げた量</span>
        </div>
      </div>
      <div className="dynhist">
        <canvas ref={hist} />
        <div className="hint dynlegend"><span style={{ color: '#8B939E' }}>― 入る音</span><span style={{ color: '#5FD39A' }}>― 出る音</span><span style={{ color: '#C08A50' }}>■ 下げた量</span><span>直近 6 秒</span></div>
      </div>
      <Params fx={fx} rows={rows} onChange={onChange} />
    </div>
  )
}
