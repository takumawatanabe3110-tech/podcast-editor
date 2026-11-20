import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import { cutLines, refToOutOrNext, restoreLine } from './editops'
import { Player } from './player'
import { usePlayhead } from './playhead'
import { ScriptPanel } from './ScriptPanel'
import { formatTime, outToRef } from './timeline'
import { Overview, Tracks, type View } from './TrackView'
import type { Peaks, Project, Segment, Transcript } from './types'

const COLORS = ['#6AA7FF', '#F2A65A', '#7BD88F', '#E58AE0']

type Save = 'saved' | 'saving' | { error: string }

export default function App() {
  const player = useMemo(() => new Player(), [])
  const [name, setName] = useState('')
  const [project, setProject] = useState<Project | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [peaks, setPeaks] = useState<Record<string, Peaks>>({})
  const [loading, setLoading] = useState('プロジェクトを読み込み中…')
  const [fatal, setFatal] = useState<string | null>(null)
  const [save, setSave] = useState<Save>('saved')
  const [selected, setSelected] = useState<number[]>([])
  const [view, setView] = useState<View>({ start: 0, span: 30 })
  const [showRuby, setShowRuby] = useState(true)
  const [refTotal, setRefTotal] = useState(60)
  const history = useRef<{ past: Segment[][]; future: Segment[][] }>({ past: [], future: [] })
  const [, bump] = useState(0)

  // ---- 読み込み
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await api.getProject()
        if (!alive) return
        const p = r.project
        setName(r.name); setProject(p); player.setProject(p)
        setRefTotal(r.derived.sources[p.sync.reference]?.duration ?? r.derived.output_end)
        const first = p.edit.segments[0]?.start ?? 0
        setView({ start: Math.max(0, first - 2), span: 30 })
        setLoading('文字起こし・波形を読み込み中…')
        const [tr, ...pk] = await Promise.all([api.getTranscript(), ...p.voices.map(v => api.getPeaks(v.source))])
        if (!alive) return
        setTranscript(tr)
        setPeaks(Object.fromEntries(p.voices.map((v, i) => [v.source, pk[i]])))
        const sids = Object.keys(p.sources)
        setLoading(`音声を読み込み中… 0/${sids.length}`)
        await player.load(sids, (d, n) => alive && setLoading(`音声を読み込み中… ${d}/${n}`))
        if (alive) { setLoading(''); player.seek(p.edit.position) }
      } catch (e) {
        if (alive) setFatal(String((e as Error).message ?? e))
      }
    })()
    return () => { alive = false }
  }, [player])

  const lines = useMemo(() => (transcript?.utterances ?? []).filter(u => u.script.trim()), [transcript])
  const speakerColor = useMemo(() => Object.fromEntries((project?.voices ?? []).map((v, i) => [v.source, COLORS[i % COLORS.length]])), [project?.voices])

  // ---- 編集（カット）。再生位置は基準時刻で保ち、再生中ならそこから鳴らし直す
  const applySegments = useCallback((segs: Segment[], record = true) => {
    if (!project) return
    const pos = player.position()
    const ref = outToRef(project.edit, pos)
    const next: Project = { ...project, edit: { ...project.edit, segments: segs } }
    if (record) { history.current.past.push(project.edit.segments); history.current.future = [] }
    setProject(next)
    player.restart(next, ref == null ? pos : refToOutOrNext(next.edit, ref))
    setSave('saving')
    api.putProject(next).then(() => setSave('saved'), e => setSave({ error: String(e.message ?? e) }))
    bump(n => n + 1)
  }, [project, player])

  const undo = useCallback(() => {
    const h = history.current
    if (!project || !h.past.length) return
    h.future.push(project.edit.segments)
    applySegments(h.past.pop()!, false)
  }, [project, applySegments])
  const redo = useCallback(() => {
    const h = history.current
    if (!project || !h.future.length) return
    h.past.push(project.edit.segments)
    applySegments(h.future.pop()!, false)
  }, [project, applySegments])

  const cutSelected = useCallback(() => {
    if (!project || !selected.length) return
    applySegments(cutLines(project.edit, lines, selected))
    setSelected([])
  }, [project, selected, lines, applySegments])

  const restore = useCallback((i: number) => {
    if (!project) return
    applySegments(restoreLine(project.edit, lines[i]))
  }, [project, lines, applySegments])

  const editText = useCallback((i: number, text: string) => {
    if (!transcript) return
    const target = lines[i]
    const next: Transcript = { ...transcript, utterances: transcript.utterances.map(u => u === target ? { ...u, script: text } : u) }
    setTranscript(next)
    setSave('saving')
    api.putTranscript(next).then(() => setSave('saved'), e => setSave({ error: String(e.message ?? e) }))
  }, [transcript, lines])

  const seekRef = useCallback((t: number) => { if (project) player.seek(refToOutOrNext(project.edit, t)) }, [project, player])

  // ---- キーボード
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable]')) return
      if (e.code === 'Space') { e.preventDefault(); player.toggle() }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (selected.length) { e.preventDefault(); cutSelected() } }
      else if (e.key === 'Escape') setSelected([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player, undo, redo, cutSelected, selected.length])

  if (fatal) return <div className="center"><div><b>読み込めませんでした</b><div className="error">{fatal}</div></div></div>
  if (!project) return <div className="center">{loading}</div>

  const total = player.totalLength()
  const off = Object.entries(project.sync.tracks)[0]?.[1]
  return (
    <div className="app">
      <header className="header">
        <div className="title"><b>{project.name || name}</b>
          <div>{name} ・ {project.voices.map(v => v.name || v.source).join('／')}</div></div>
        <div className="chips">
          {off && <span className="chip">同期済み（ずれ {off.offset_sec.toFixed(3)}秒）</span>}
          {project.voices.some(v => v.denoise) && <span className="chip">ノイズ除去</span>}
          {transcript ? <span className="chip">文字起こし済み（{lines.length}発言）</span> : <span className="chip warn">文字起こしなし（transcribe で作れます）</span>}
          {loading && <span className="chip busy">{loading}</span>}
          {save === 'saved' ? <span className="chip">保存済み</span> : save === 'saving' ? <span className="chip busy">保存中…</span>
            : <span className="chip warn" title={save.error}>保存できませんでした：{save.error}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={undo} disabled={!history.current.past.length} title="⌘Z">元に戻す</button>
          <button className="btn" onClick={redo} disabled={!history.current.future.length} title="⇧⌘Z">やり直す</button>
        </div>
      </header>
      <div className="body">
        <ScriptPanel project={project} player={player} lines={lines} colors={speakerColor}
          selected={selected} setSelected={setSelected} onSeekRef={seekRef} onEditText={editText} onRestore={restore} onCut={cutSelected} />
        <main className="main">
          <Transport player={player} project={project} lines={lines} total={total} disabled={!!loading} onSeekRef={seekRef}
            showRuby={showRuby} setShowRuby={setShowRuby} />
          <Overview project={project} player={player} view={view} total={total} />
          <Tracks project={project} utterances={transcript?.utterances ?? []} peaks={peaks} player={player} view={view} setView={setView}
            refTotal={refTotal} showRuby={showRuby} colors={COLORS} />
        </main>
      </div>
    </div>
  )
}

function Transport({ player, project, lines, total, disabled, onSeekRef, showRuby, setShowRuby }: {
  player: Player; project: Project; lines: { start: number }[]; total: number; disabled: boolean; onSeekRef: (t: number) => void
  showRuby: boolean; setShowRuby: (b: boolean) => void
}) {
  const clock = usePlayhead(player, t => formatTime(t))
  const playing = usePlayhead(player, (_t, p) => p)
  // 再生が最後まで行ったら止める
  const ended = usePlayhead(player, (t, p) => p && t >= total)
  useEffect(() => { if (ended) player.pause() }, [ended, player])
  const jump = (dir: 1 | -1) => {
    const r = outToRef(project.edit, player.position()) ?? 0
    const starts = lines.map(l => l.start)
    const t = dir > 0 ? starts.find(s => s > r + 0.05) : [...starts].reverse().find(s => s < r - 0.5)
    if (t != null) onSeekRef(t)
  }
  return (
    <div className="transport">
      <button className="btn" aria-label="前の発言へ" onClick={() => jump(-1)}>⏮</button>
      <button className="btn round" aria-label={playing ? '一時停止' : '再生'} disabled={disabled} onClick={() => player.toggle()}>
        {playing
          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
          : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>}
      </button>
      <button className="btn" aria-label="次の発言へ" onClick={() => jump(1)}>⏭</button>
      <div className="clock mono">{clock} <span>/ {formatTime(total)}</span></div>
      <span className="kbd">Space：再生／一時停止</span>
      <div className="spacer" />
      <label><input type="checkbox" checked={showRuby} onChange={e => setShowRuby(e.target.checked)} />波形の上にルビ</label>
      <span className="kbd">波形の上でピンチ：拡大・縮小 ／ 2本指で左右：移動</span>
    </div>
  )
}
