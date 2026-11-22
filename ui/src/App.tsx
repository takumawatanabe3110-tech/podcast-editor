import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import { EditTimeline, type ChangeOpts } from './EditTimeline'
import { cutLines, refToOutOrNext, restoreLine } from './editops'
import { EffectsView } from './EffectsView'
import { Mixer, type ExportStatus } from './Mixer'
import { MASTER_ID, Player } from './player'
import type { PresetCtx } from './presetctx'
import { type Current } from './library'
import { usePlayhead } from './playhead'
import { ScriptPanel } from './ScriptPanel'
import { clamp, Splitter, useLayout } from './layout'
import { formatTime, outToRef } from './timeline'
import { Overview, type View } from './TrackView'
import type { Peaks, Project, Transcript } from './types'

const COLORS = ['#6AA7FF', '#F2A65A', '#7BD88F', '#E58AE0']
const GROUP_MS = 1500 // 同じ操作（フェーダーを動かし続ける等）は、この間隔内なら「元に戻す」1回分にまとめる

type Save = 'saved' | 'saving' | { error: string }
type Screen = 'edit' | 'fx'

/** 並び（カット・BGM の位置やカーブ）が変わったか。変わっていなければ鳴らし直さずに音量だけ変える */
function structuralChange(a: Project, b: Project) {
  return a.edit !== b.edit || a.bgm !== b.bgm || a.sync !== b.sync || a.voices.some((v, i) => v.keyframes !== b.voices[i]?.keyframes)
}

export default function App({ current, onShowList, player: given, active = true, onReady }: {
  current?: Current; onShowList?: () => void
  /** 音を鳴らす Player（一覧画面と共有して、画面を切り替えても止めないため）。なければ自分で作る */
  player?: Player
  /** false のあいだは一覧画面の裏に隠れている（キー操作を受けない） */
  active?: boolean
  /** 音を読み込み終えたとき */
  onReady?: () => void
} = {}) {
  const player = useMemo(() => given ?? new Player(), [given])
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const [name, setName] = useState('')
  const [project, setProject] = useState<Project | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [peaks, setPeaks] = useState<Record<string, Peaks>>({})
  const [loading, setLoading] = useState('プロジェクトを読み込み中…')
  const [fatal, setFatal] = useState<string | null>(null)
  const [save, setSave] = useState<Save>('saved')
  const [selected, setSelected] = useState<number[]>([])
  const [view, setView] = useState<View>({ start: 0, span: 40 }) // 完成版の時刻（編集画面の表示範囲）
  const [showRuby, setShowRuby] = useState(true)
  const [refTotal, setRefTotal] = useState(60)
  const [screen, setScreen] = useState<Screen>('edit')
  const [denoiseBusy, setDenoiseBusy] = useState<Record<string, boolean>>({})
  const [solo, setSoloState] = useState<Set<string>>(new Set())
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ state: 'idle' })
  const [layout, setLayout] = useLayout()
  const [help, setHelp] = useState(false)
  const dragBase = useRef(0) // 境目のドラッグを始めたときの広さ
  const mixRef = useRef<HTMLDivElement>(null)
  const history = useRef<{ past: Project[]; future: Project[]; group: string | null; at: number }>({ past: [], future: [], group: null, at: 0 })
  const [, bump] = useState(0)
  const projectRef = useRef<Project | null>(null)
  projectRef.current = project

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
        setView({ start: 0, span: 40 }); void first
        setLoading('文字起こし・波形を読み込み中…')
        const sids = Object.keys(p.sources)
        const [tr, ...pk] = await Promise.all([api.getTranscript(), ...sids.map(s => api.getPeaks(s))])
        if (!alive) return
        setTranscript(tr)
        setPeaks(Object.fromEntries(sids.map((s, i) => [s, pk[i]])))
        setLoading(`音声を読み込み中… 0/${sids.length}`)
        await player.load(sids, (d, n) => alive && setLoading(`音声を読み込み中… ${d}/${n}`))
        if (alive) { setLoading(''); if (!player.playing) player.seek(0); onReadyRef.current?.() } // 0 秒から（OP の BGM の頭から聴けるように）
        const ex = await api.getExport()
        if (alive) setExportStatus(ex)
      } catch (e) {
        if (alive) setFatal(String((e as Error).message ?? e))
      }
    })()
    return () => { alive = false }
  }, [player])

  // ---- 保存（続けて変えたときは最後の状態だけを送る）
  const saveTimer = useRef(0)
  const saveSoon = useCallback((p: Project) => {
    setSave('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      api.putProject(p).then(() => { if (projectRef.current === p) setSave('saved') }, e => setSave({ error: String(e.message ?? e) }))
    }, 300)
  }, [])

  /** プロジェクトを変える。並びが変わったら、再生位置（基準時刻）を保ってそこから鳴らし直す */
  const apply = useCallback((next: Project, prev: Project, restart = true) => {
    setProject(next)
    if (structuralChange(prev, next)) {
      if (restart) {
        const pos = player.position()
        const ref = outToRef(prev.edit, pos)
        player.restart(next, ref == null ? pos : refToOutOrNext(next.edit, ref))
      } else player.updateMix(next)
    } else player.updateMix(next)
    saveSoon(next)
    bump(n => n + 1)
    // ノイズ除去の設定が変わった声は、保存してからサーバーに作り直してもらい、読み込み直す
    const changed = next.voices.filter(v => JSON.stringify(v.denoise) !== JSON.stringify(prev.voices.find(x => x.source === v.source)?.denoise))
    if (changed.length) {
      setDenoiseBusy(b => ({ ...b, ...Object.fromEntries(changed.map(v => [v.source, true])) }))
      api.putProject(next).then(() => Promise.all(changed.map(v => player.reload(v.source).finally(() =>
        setDenoiseBusy(b => ({ ...b, [v.source]: false })))))).catch(e => setSave({ error: String(e.message ?? e) }))
    }
  }, [player, saveSoon])

  /** 画面からの変更。group が同じ操作が続くあいだは「元に戻す」1回分にまとめる */
  const update = useCallback((next: Project, group?: string, opts?: ChangeOpts) => {
    const prev = projectRef.current
    if (!prev || next === prev) return
    const h = history.current, now = Date.now()
    if (!(group && h.group === group && now - h.at < GROUP_MS)) { h.past.push(prev); h.future = [] }
    h.group = group ?? null; h.at = now
    projectRef.current = next
    apply(next, prev, opts?.restart ?? true)
  }, [apply])

  const undo = useCallback(() => {
    const h = history.current, cur = projectRef.current
    if (!cur || !h.past.length) return
    const prev = h.past.pop()!
    h.future.push(cur); h.group = null
    projectRef.current = prev
    apply(prev, cur)
  }, [apply])
  const redo = useCallback(() => {
    const h = history.current, cur = projectRef.current
    if (!cur || !h.future.length) return
    const next = h.future.pop()!
    h.past.push(cur); h.group = null
    projectRef.current = next
    apply(next, cur)
  }, [apply])

  const lines = useMemo(() => (transcript?.utterances ?? []).filter(u => u.script.trim()), [transcript])
  const speakerColor = useMemo(() => Object.fromEntries((project?.voices ?? []).map((v, i) => [v.source, COLORS[i % COLORS.length]])), [project?.voices])

  const setSegments = useCallback((segments: Project['edit']['segments']) => {
    const p = projectRef.current
    if (p) update({ ...p, edit: { ...p.edit, segments } }, `cut-${Date.now()}`)
  }, [update])

  const cutSelected = useCallback(() => {
    if (!project || !selected.length) return
    setSegments(cutLines(project.edit, lines, selected))
    setSelected([])
  }, [project, selected, lines, setSegments])

  const restore = useCallback((i: number) => {
    if (project) setSegments(restoreLine(project.edit, lines[i]))
  }, [project, lines, setSegments])

  const editText = useCallback((i: number, text: string) => {
    if (!transcript) return
    const target = lines[i]
    const next: Transcript = { ...transcript, utterances: transcript.utterances.map(u => u === target ? { ...u, script: text } : u) }
    setTranscript(next)
    setSave('saving')
    api.putTranscript(next).then(() => setSave('saved'), e => setSave({ error: String(e.message ?? e) }))
  }, [transcript, lines])

  const seekRef = useCallback((t: number) => { if (project) player.seek(refToOutOrNext(project.edit, t)) }, [project, player])
  const setSolo = useCallback((s: Set<string>) => setSoloState(s), [])
  // エフェクト画面では、選んだトラックだけを鳴らす（マスターは全部）。ほかの画面ではミキサーのソロ
  const [fxTrack, setFxTrack] = useState<string | null>(null)
  useEffect(() => {
    if (screen !== 'fx') { player.setSolo(solo); return }
    const t = fxTrack ?? projectRef.current?.voices[0]?.source ?? MASTER_ID
    player.setSolo(t === MASTER_ID ? new Set() : new Set([t]))
  }, [screen, fxTrack, solo, player])

  // ---- 書き出し：保存を済ませてから始め、終わるまで1秒ごとに様子を見る
  // ---- いつもの設定（プリセット）
  const [presetNames, setPresetNames] = useState<string[]>([])
  const [presetPick, setPresetPick] = useState<string | null>(null)
  const [presetData, setPresetData] = useState<api.Preset | null>(null)
  const presetCurrent = presetPick ?? (project?.preset || presetNames[0] || null)
  useEffect(() => { api.listPresets().then(l => setPresetNames(l.map(x => x.name)), () => setPresetNames([])) }, [])
  const reloadPreset = useCallback(async () => {
    if (!presetCurrent) { setPresetData(null); return }
    try { setPresetData(await api.getPreset(presetCurrent)) } catch { setPresetData(null) }
  }, [presetCurrent])
  useEffect(() => { void reloadPreset() }, [reloadPreset])
  /** 画面の変更をサーバーに保存し終える（プリセットに書き込む前に） */
  const flush = useCallback(async () => {
    const p = projectRef.current
    if (!p) return
    window.clearTimeout(saveTimer.current)
    await api.putProject(p); setSave('saved')
  }, [])
  const presetCtx: PresetCtx = { names: presetNames, current: presetCurrent, setCurrent: setPresetPick, data: presetData, reload: reloadPreset, flush }

  /** トラックの名前を変える（台本の名前も変える） */
  const renameVoice = useCallback((sid: string, name: string) => {
    const p = projectRef.current
    if (!p) return
    const old = p.voices.find(v => v.source === sid)?.name
    update({ ...p, voices: p.voices.map(v => (v.source === sid ? { ...v, name } : v)) }, `rename-${Date.now()}`)
    if (transcript) {
      const next: Transcript = { ...transcript, utterances: transcript.utterances.map(u => (u.source === sid || u.speaker === old ? { ...u, speaker: u.source === sid ? name : u.speaker } : u)) }
      setTranscript(next)
      api.putTranscript(next).catch(e => setSave({ error: String(e.message ?? e) }))
    }
  }, [update, transcript])

  const startExport = useCallback(async () => {
    const p = projectRef.current
    if (!p) return
    try {
      window.clearTimeout(saveTimer.current)
      await api.putProject(p); setSave('saved')
      await api.startExport()
      setExportStatus({ state: 'running', elapsed: 0 })
    } catch (e) {
      setExportStatus({ state: 'error', message: String((e as Error).message ?? e) })
    }
  }, [])
  useEffect(() => {
    if (exportStatus.state !== 'running') return
    const id = window.setTimeout(() => { api.getExport().then(setExportStatus, () => {}) }, 1000)
    return () => window.clearTimeout(id)
  }, [exportStatus])


  // 書き出しの残り時間：段階によって進み具合が止まり、計算した値が増えることがあるので、増えないようにする（カウントダウン）
  const remainRef = useRef<{ v: number; at: number } | null>(null)
  let remainShown: number | null = null
  if (exportStatus.state === 'running' && exportStatus.remaining != null) {
    const now = performance.now(), prev = remainRef.current
    const counted = prev ? prev.v - (now - prev.at) / 1000 : Infinity
    remainShown = Math.max(0, Math.min(exportStatus.remaining, counted))
    if (!prev || remainShown !== prev.v) remainRef.current = { v: remainShown, at: now }
  } else if (exportStatus.state !== 'running') remainRef.current = null

  // ---- キーボード
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return // 一覧画面を見ているあいだ
      // Ctrl+S：台本の欄を開け閉め（文字を直している最中でも効く）
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 's') { e.preventDefault(); setLayout({ scriptOpen: !layout.scriptOpen }); return }
      const el = e.target as HTMLElement
      // Space：文字を打つ欄（台本の編集・検索など）以外なら、どこにいても再生／一時停止。
      // スライダーやボタンを触った直後でも効くように、その部品から操作を外す（ボタンが押されないように）
      if (e.code === 'Space' && !el.closest('textarea, select, [contenteditable], input[type=text], input[type=search], input:not([type])')) {
        e.preventDefault()
        if (el !== document.body) el.blur()
        // 読み込み中は再生ボタンと同じく効かせない（一覧の MP3 から引き継ぐ途中に、2つの音が重ならないように）
        if (!e.repeat && !loading) player.toggle()
        return
      }
      if (el.closest('input, textarea, select, [contenteditable]')) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if (screen === 'edit' && (e.key === 'Delete' || e.key === 'Backspace')) { if (selected.length) { e.preventDefault(); cutSelected() } }
      else if (e.key === 'Escape') { setSelected([]); setHelp(false) }
      else if (e.key === '?') setHelp(h => !h)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, loading, player, undo, redo, cutSelected, selected.length, screen, layout.scriptOpen, setLayout])

  if (fatal) return <div className="center"><div><b>読み込めませんでした</b><div className="error">{fatal}</div></div></div>
  if (!project) return <div className="center">{loading}</div>

  const total = player.totalLength()
  const off = Object.entries(project.sync.tracks)[0]?.[1]
  const info = [
    name, project.voices.map(v => v.name || v.source).join('／'),
    off ? `同期のずれ ${off.offset_sec.toFixed(3)} 秒` : '',
    project.voices.some(v => v.denoise) ? 'ノイズ除去あり' : '',
    transcript ? `文字起こし ${lines.length} 発言` : '文字起こしなし（transcribe コマンドで作れます）',
  ].filter(Boolean).join('\n')
  return (
    <div className="app">
      <div className="frame appframe">
      <header className="header">
        {onShowList && current?.program && (
          <button className="btn icon" aria-label="一覧へ" title="一覧へ（番組・回）" onClick={onShowList}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        )}
        <div className="title" title={info}><b>{project.name || name}</b>
          <span>{project.voices.map(v => v.name || v.source).join('・')}{save === 'saved' ? ' ・ 保存済み' : save === 'saving' ? ' ・ 保存中…' : ''}</span></div>
        <div className="tabs" role="group" aria-label="画面の切り替え">
          <button aria-pressed={screen === 'edit'} onClick={() => setScreen('edit')}>編集</button>
          <button aria-pressed={screen === 'fx'} onClick={() => setScreen('fx')}>エフェクト</button>
        </div>
        {loading && <span className="status busy">{loading}</span>}
        {!transcript && !loading && <span className="status warn">文字起こしなし</span>}
        <Transport player={player} project={project} lines={lines} total={total} disabled={!!loading} onSeekRef={seekRef}>
          {screen === 'edit' ? <Overview project={project} player={player} view={view} total={total} /> : <Overview project={project} player={player} total={total} />}
        </Transport>
        {typeof save === 'object'
          ? <span className="status warn" title={save.error}>保存できませんでした</span>
          : <span className={`savedot ${save}`} role="status" aria-label={save === 'saved' ? '保存済み' : '保存中'} title={save === 'saved' ? '保存済み' : '保存中…'} />}
        <button className="btn icon" onClick={undo} disabled={!history.current.past.length} aria-label="元に戻す" title="元に戻す（⌘Z）">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
        </button>
        <button className="btn icon" onClick={redo} disabled={!history.current.future.length} aria-label="やり直す" title="やり直す（⇧⌘Z）">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></svg>
        </button>
        <div className="helpwrap">
          <button className="btn icon" aria-label="操作の一覧" aria-expanded={help} title="操作の一覧（?）" onClick={() => setHelp(h => !h)}>?</button>
          {help && <Help screen={screen} onClose={() => setHelp(false)} />}
        </div>
        {exportStatus.state === 'running' && (
          <span className="status busy exporting" title={exportStatus.stage ?? ''}>
            <span className="pbar"><span style={{ width: `${Math.round((exportStatus.progress ?? 0) * 100)}%` }} /></span>
            {remainShown != null ? (remainShown <= 3 ? 'まもなく終わります' : `残り約${fmtRemain(remainShown)}`) : '書き出しを準備中…'}
          </span>
        )}
        <button className="btn icon primary" onClick={startExport} disabled={exportStatus.state === 'running'}
          aria-label="MP3 に書き出す" title="MP3 に書き出す">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></svg>
        </button>
      </header>
      {screen === 'edit' ? (
        <div className="body" style={{ gridTemplateColumns: layout.scriptOpen ? `minmax(0, ${layout.scriptW}px) 14px minmax(360px, 1fr)` : 'minmax(0, 1fr)' }}>
          {layout.scriptOpen && <>
            <ScriptPanel project={project} player={player} lines={lines} colors={speakerColor}
              selected={selected} setSelected={setSelected} onSeekRef={seekRef} onEditText={editText} onRestore={restore} />
            <Splitter dir="col" label="台本の幅" onStart={() => { dragBase.current = layout.scriptW }}
              onDrag={d => setLayout({ scriptW: clamp(dragBase.current + d, 240, Math.max(260, window.innerWidth - 420)) })} />
          </>}
          <main className="main editmain">
            <div className="trackwrap glass">
              <EditTimeline project={project} utterances={transcript?.utterances ?? []} peaks={peaks} player={player} view={view} setView={setView}
                total={total} showRuby={showRuby} setShowRuby={setShowRuby} colors={COLORS} onChange={update}
                refDur={sid => (player.duration(sid) ?? refTotal) - (project.sync.tracks[sid]?.offset_sec ?? 0)}
                onOpenFx={t => { setFxTrack(t); setScreen('fx') }}
                onRename={renameVoice} />
            </div>
            <Splitter dir="row" label="ミキサーの高さ" onStart={() => { dragBase.current = mixRef.current?.getBoundingClientRect().height ?? layout.mixerH }}
              onDrag={d => setLayout({ mixerOpen: true, mixerAuto: false, mixerH: clamp(dragBase.current - d, 140, Math.max(160, window.innerHeight - 260)) })}
              onDoubleClick={() => setLayout({ mixerOpen: true, mixerAuto: true })} />
            {layout.mixerOpen && (
              <div ref={mixRef} className={`mixwrap${layout.mixerAuto ? ' auto' : ''}`} style={layout.mixerAuto ? undefined : { height: layout.mixerH }}>
                <Mixer project={project} player={player} colors={COLORS} solo={solo} setSolo={setSolo}
                  onChange={(p, g) => update(p, g)} exportStatus={exportStatus} />
              </div>
            )}
          </main>
        </div>
      ) : screen === 'fx' ? (
        <div className="body bgmbody">
          <main className="main" style={{ overflow: 'hidden' }}>
            <EffectsView project={project} player={player} colors={COLORS} onChange={update} denoiseBusy={denoiseBusy} track={fxTrack} setTrack={setFxTrack} preset={presetCtx} />
          </main>
        </div>
      ) : null}
      </div>
    </div>
  )
}

/** 残り時間の表示（例：45秒、1分20秒） */
function fmtRemain(sec: number) {
  const s = Math.max(1, Math.round(sec))
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60 ? `${s % 60}秒` : ''}`
}

const HELP: Record<'common' | Screen, [string, string][]> = {
  common: [
    ['Space', '再生／一時停止'],
    ['⌘Z ／ ⇧⌘Z', '元に戻す／やり直す'],
    ['目盛りをクリック', 'そこへ移動（押したまま横に動かすと、ついてくる）'],
    ['ピンチ', '波形の拡大・縮小'],
    ['2本指で左右', '波形を左右に移動'],
    ['境目をドラッグ', '欄の広さを変える'],
  ],
  edit: [
    ['Ctrl+S', '台本の欄を開く／閉じる'],
    ['文をクリック', 'そこへ移動して文字を直す（Enter 確定・Esc 取り消し。音声は変わらない）'],
    ['時刻をクリック', 'その文を選ぶ（Shift で範囲、⌘ で追加）→ Delete でカット'],
    ['カット済みの文をクリック', 'カットを戻す'],
    ['波形をクリック', 'そこへ移動（区間を選ぶ → Delete で取り除く）'],
    ['波形の上をドラッグ', '範囲を選ぶ → Delete でカット'],
    ['C', '再生位置に切れ目を入れる'],
    ['区間の端をドラッグ', '削る・カットした部分を戻す'],
    ['⇔ をドラッグ', '声全体の位置（話し始め）を動かす'],
    ['音量の線をクリック', '点を打つ → ドラッグで変える（選んで Delete で消す）'],
    ['BGM をドラッグ', '位置を動かす（端で頭・終わりを削る・戻す、□ でフェード）'],
    ['トラック名をクリック', 'エフェクトを開く（名前の欄は書き換えられる）'],
    ['フェーダーをダブルクリック', '0 dB に戻す'],
    ['ミキサーの上の境目をダブルクリック', 'ミキサーの高さを波形に合わせて戻す'],
  ],
  fx: [
    ['トラックを選ぶ', 'そのトラックだけ鳴らす（マスターは全部）'],
    ['処理前／処理後', 'エフェクトとノイズ除去をかけない音と聴き比べ'],
    ['順番', 'EQ とダイナミクスのどちらを先にかけるか'],
    ['EQ の点を左右', '周波数'],
    ['EQ の点を上下', '量（dB）'],
    ['ホイール・Alt＋ドラッグ', 'ベルの幅（Q）'],
    ['EQ の点をダブルクリック', '0 dB に戻す'],
    ['□ を左右', 'しきい値'],
    ['○ を上下', 'レシオ（コンプ）'],
    ['グラフの上で上下', 'ニー（コンプ）／下げる量（ゲート）'],
  ],
}

function Help({ screen, onClose }: { screen: Screen; onClose: () => void }) {
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.helpwrap')) onClose() }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [onClose])
  return (
    <div className="help" role="dialog" aria-label="操作の一覧">
      {[...HELP.common, ...HELP[screen]].map(([k, v]) => <div key={k} className="hrow"><span className="kbd">{k}</span><span>{v}</span></div>)}
    </div>
  )
}

function Transport({ player, project, lines, total, disabled, onSeekRef, children }: {
  player: Player; project: Project; lines: { start: number }[]; total: number; disabled: boolean; onSeekRef: (t: number) => void
  children?: React.ReactNode // 再生バー（時刻の横に伸ばして置く）
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
      <button className="btn icon" aria-label="前の発言へ" title="前の発言へ" onClick={() => jump(-1)}>⏮</button>
      <button className="btn round" aria-label={playing ? '一時停止' : '再生'} title="再生／一時停止（Space）" disabled={disabled} onClick={() => player.toggle()}>
        {playing
          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
          : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>}
      </button>
      <button className="btn icon" aria-label="次の発言へ" title="次の発言へ" onClick={() => jump(1)}>⏭</button>
      <div className="clock mono">{clock} <span>/ {formatTime(total)}</span></div>
      {children ? <div className="tbar">{children}</div> : <div className="spacer" />}
    </div>
  )
}
