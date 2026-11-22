// ミキサー：トラックごとのフェーダー・メーター・ミュート／ソロと、書き出しの設定。
import { useEffect, useRef } from 'react'
import { BGM_ID, MASTER_ID, faderDb, type Player } from './player'
import type { Project } from './types'

export interface ExportStatus {
  state: 'idle' | 'running' | 'done' | 'error'
  progress?: number; stage?: string; remaining?: number | null
  path?: string; elapsed?: number; message?: string
  report?: { duration: number; peak_dbfs: number; clipped: boolean; loudness_before_lufs: number | null; loudness_lufs: number | null; true_peak_dbtp: number | null }
}

/** エフェクトの並びのフェーダー（gain）を合計 db にする。なければ最後に足す */
export function withFader(effects: unknown[], db: number): unknown[] {
  const list = [...effects] as { type?: string; db?: number }[]
  const idx = list.map((e, i) => (e?.type === 'gain' ? i : -1)).filter(i => i >= 0)
  if (!idx.length) return [...list, { type: 'gain', db }]
  const last = idx[idx.length - 1]
  const others = faderDb(list.filter((_, i) => i !== last))
  list[last] = { ...list[last], db: Math.round((db - others) * 10) / 10 }
  return list
}


const fmtDb = (db: number) => `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`

interface Props {
  project: Project; player: Player; colors: string[]
  solo: Set<string>; setSolo: (s: Set<string>) => void
  onChange: (p: Project, group: string) => void
  exportStatus: ExportStatus
}

export function Mixer({ project, player, colors, solo, setSolo, onChange, exportStatus }: Props) {
  const toggleSolo = (id: string) => { const s = new Set(solo); if (s.has(id)) s.delete(id); else s.add(id); setSolo(s) }
  const out = project.output as { loudness_lufs?: number | null; true_peak_dbtp?: number; mp3_kbps?: number; channels?: number }
  return (
    <section className="mixer" aria-label="ミキサー">
      <div className="mixstrips">
      {project.voices.map((v, i) => (
        <Strip key={v.source} id={v.source} player={player} name={v.name || v.source} color={colors[i % colors.length]}
          fader={faderDb(v.effects)}
          detail={`声の音量 ${fmtDb(v.gain_db)} dB（自動）`}
          mute={v.mute} soloOn={solo.has(v.source)}
          onMute={() => onChange({ ...project, voices: project.voices.map(x => x === v ? { ...x, mute: !x.mute } : x) }, `mute-${v.source}-${Date.now()}`)}
          onSolo={() => toggleSolo(v.source)}
          onFader={db => onChange({ ...project, voices: project.voices.map(x => x === v ? { ...x, effects: withFader(x.effects, db) } : x) }, `fader-${v.source}`)} />
      ))}
      <Strip id={BGM_ID} player={player} name="BGM" color="#B79CFF"
        fader={faderDb(project.bgm_effects)} detail={project.bgm.map(c => c.source).join('・') || 'なし'}
        soloOn={solo.has(BGM_ID)} onSolo={() => toggleSolo(BGM_ID)}
        onFader={db => onChange({ ...project, bgm_effects: withFader(project.bgm_effects, db) }, 'fader-bgm')} />
      <Strip id={MASTER_ID} player={player} name="マスター" color="#8A88B0"
        fader={faderDb(project.master_effects)} detail="全体（Bus 1）"
        onFader={db => onChange({ ...project, master_effects: withFader(project.master_effects, db) }, 'fader-master')} />
      </div>
      <div className="mixcard glass export">
        <b title={`MP3 ${out.mp3_kbps ?? 128} kbps ${out.channels === 1 ? 'モノラル' : 'ステレオ'}`}>書き出しの設定</b>
        <label className="row">ラウドネス
          <input type="number" step={0.5} value={out.loudness_lufs ?? ''} aria-label="ラウドネスの目標（LUFS）"
            onChange={e => onChange({ ...project, output: { ...project.output, loudness_lufs: e.target.value === '' ? null : +e.target.value } }, 'lufs')} />
          <span title="Spotify の基準は −14">LUFS</span></label>
        <label className="row">ピークの上限
          <input type="number" step={0.5} value={out.true_peak_dbtp ?? -1} aria-label="ピークの上限（dBTP）"
            onChange={e => onChange({ ...project, output: { ...project.output, true_peak_dbtp: +e.target.value } }, 'tp')} />
          <span title="音割れ防止">dBTP</span></label>
        <ExportResult s={exportStatus} />
      </div>
    </section>
  )
}

function ExportResult({ s }: { s: ExportStatus }) {
  if (s.state === 'idle') return null
  if (s.state === 'running') return <div className="chip busy">書き出し中（{Math.round((s.progress ?? 0) * 100)}%・{s.stage ?? '準備中'}）{s.remaining != null ? `残り約${Math.max(1, Math.round(s.remaining))}秒` : ''}</div>
  if (s.state === 'error') return <div className="error">書き出せませんでした：{s.message}</div>
  const r = s.report!
  return (
    <div className="done">
      <div className="chip" title={s.path}>書き出しました（{Math.round(s.elapsed ?? 0)}秒）</div>
      <div className="hint" style={{ wordBreak: 'break-all' }}>{s.path?.split('/').pop()}</div>
      <div className="grid2">
        <span>長さ</span><span>{Math.floor(r.duration / 60)}分{(r.duration % 60).toFixed(1)}秒</span>
        {r.loudness_lufs != null && <><span>ラウドネス</span><span>{r.loudness_before_lufs?.toFixed(1)} → <b>{r.loudness_lufs.toFixed(2)} LUFS</b></span></>}
        {r.true_peak_dbtp != null && <><span>トゥルーピーク</span><span>{r.true_peak_dbtp.toFixed(2)} dBTP</span></>}
        {r.clipped && <><span>注意</span><span className="error">ピークが 0 dBFS を超えています</span></>}
      </div>
    </div>
  )
}

const MIN_DB = -30, MAX_DB = 12

interface StripProps {
  id: string; player: Player; name: string; color: string; fader: number; detail: string
  mute?: boolean; soloOn?: boolean; onMute?: () => void; onSolo?: () => void; onFader: (db: number) => void
}

function Strip({ id, player, name, color, fader, detail, mute, soloOn, onMute, onSolo, onFader }: StripProps) {
  return (
    <div className="mixcard glass strip" title={detail}>
      <b className="sname"><span className="dot" style={{ background: color }} />{name}</b>
      <div className="sval">
        <input type="number" step={0.1} min={MIN_DB} max={MAX_DB} value={fader} aria-label={`${name}のフェーダーの値`}
          onChange={e => e.target.value !== '' && onFader(Math.max(MIN_DB, Math.min(MAX_DB, +e.target.value)))} />
        <span className="hint">dB</span>
      </div>
      <div className="sbody">
        <Meter id={id} player={player} />
        <input className="fader" type="range" min={MIN_DB} max={MAX_DB} step={0.1} value={fader}
          aria-label={`${name}のフェーダー（dB）`} title="ダブルクリックで 0 dB に戻す"
          onChange={e => onFader(+e.target.value)} onDoubleClick={() => onFader(0)} />
      </div>
      {(onMute || onSolo) && (
        <div className="ms">
          {onMute && <button className={`msbtn${mute ? ' on-m' : ''}`} aria-pressed={!!mute} aria-label={`${name}をミュート`} onClick={onMute}>M</button>}
          {onSolo && <button className={`msbtn${soloOn ? ' on-s' : ''}`} aria-pressed={!!soloOn} aria-label={`${name}をソロ`} onClick={onSolo}>S</button>}
        </div>
      )}
    </div>
  )
}

/** メーター：−60〜0 dBFS。ピークの目盛りを少しの間残す */
function Meter({ id, player }: { id: string; player: Player }) {
  const bar = useRef<HTMLDivElement>(null), hold = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0, level = -Infinity, peak = -Infinity, peakAt = 0
    const pct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
    const loop = (now: number) => {
      const db = player.playing ? player.levels()[id] ?? -Infinity : -Infinity
      level = Math.max(db, level - 1.2) // 下がるときはゆっくり
      if (db >= peak || now - peakAt > 1200) { peak = db; peakAt = now }
      if (bar.current) {
        bar.current.style.height = `${pct(level)}%`
        bar.current.style.background = level > -1 ? '#FF6B6B' : level > -9 ? '#E8C547' : '#5FD39A'
      }
      if (hold.current) { hold.current.style.bottom = `${pct(peak)}%`; hold.current.style.opacity = peak > -60 ? '1' : '0' }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [id, player])
  return (
    <div className="meter" aria-hidden="true">
      <div ref={bar} className="mbar" />
      <div ref={hold} className="mhold" />
    </div>
  )
}
