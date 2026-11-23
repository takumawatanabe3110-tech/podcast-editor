// 一覧画面（案D）：左に番組（開け閉めで中の項目）、真ん中に回の一覧と再生バー、右に選んだ回の様子と文字起こし。
// 真ん中の欄のどこに素材をドロップしても、確認のあと新しい回を作る（処理中なら順番待ち）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listPresets } from './api'
import { collectDropped, guessDate } from './dropfiles'
import * as lib from './library'
import { useNowPlaying, type NowPlaying, type NowPlayingDeps } from './nowplaying'
import './library.css'

const fmtDur = (s?: number | null) => (s ? `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒` : '—')
const fmtDate = (id: string) => (/^\d{8}$/.test(id) ? `${id.slice(0, 4)}/${id.slice(4, 6)}/${id.slice(6)}` : id)
const fmtClock = (s: number) => { const t = Math.max(0, Math.floor(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` }
const today = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` }
const fmtRemain = (sec: number) => { const s = Math.max(1, Math.round(sec)); return s < 60 ? `${s}秒` : `${Math.round(s / 60)}分` }

// 番組・回の色（アートワークがないときのタイル）
const COVERS = [['#E08A5C', '#C2552A'], ['#6FB5E8', '#3A7BC8'], ['#7FD1A3', '#3E9C6A'], ['#A3A1F2', '#6E6BE0'], ['#E6A86E', '#C77A3E'], ['#E58BB0', '#C2507E']]
const hash = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0)
const coverOf = (key: string) => { const [a, b] = COVERS[hash(key) % COVERS.length]; return `linear-gradient(150deg, ${a}, ${b})` }
const SPEAKER = ['#6E8BEF', '#E59A56', '#8E6CEF', '#4FB98A', '#D9647A', '#C9A227']
const initial = (name: string) => [...name.trim()][0] ?? '?'

type View = 'all' | 'busy' | 'review' | 'media' | 'settings'
type Filter = 'all' | 'review' | 'busy' | 'exported'

const openCount = (e: lib.Episode) => (e.review ?? []).filter(f => !f.resolved).length

const Icon = {
  play: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4l12 8-12 8z" /></svg>,
  pause: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>,
  chev: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>,
  clock: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>,
  warn: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 3l9 16H3z" /><path d="M12 10v4" /><path d="M12 17h.01" /></svg>,
  note: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>,
  gear: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></svg>,
  upload: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V3" /><path d="M7 8l5-5 5 5" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>,
  search: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></svg>,
  copy: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>,
  edit: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>,
  wave: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 4v16" /><path d="M8 8v8" /><path d="M16 8v8" /><path d="M4 11v2" /><path d="M20 11v2" /></svg>,
  back15: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fill="currentColor" stroke="none" fontWeight="700">15</text></svg>,
  fwd15: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /><text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fill="currentColor" stroke="none" fontWeight="700">15</text></svg>,
  vol: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16.5 8.5a5 5 0 0 1 0 7" /></svg>,
}

// ---------------------------------------------------------------- 画面

export function LibraryView({ current, onOpen, now }: {
  current: lib.Current | null
  /** 回を編集画面で開く（開いている回なら、聴いている音を止めずに戻る） */
  onOpen: (program: string, episode: string) => Promise<void>
  now: NowPlayingDeps
}) {
  const [libData, setLib] = useState<lib.Library | null>(null)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<string | null>(current?.program || null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<View>('all')
  const [selEp, setSelEp] = useState<string | null>(current?.episode || null)
  const [adding, setAdding] = useState(false)
  const player = useNowPlaying(now)

  const reload = useCallback(async () => {
    try {
      const l = await lib.getLibrary(); setLib(l)
      setSel(s => s ?? l.programs[0]?.id ?? null)
    } catch (e) { setErr(String((e as Error).message)) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => { if (sel) setExpanded(x => (sel in x ? x : { ...x, [sel]: true })) }, [sel])

  const prog = libData?.programs.find(p => p.id === sel) ?? null
  // 選んだ回：なければ、いちばん新しい「できあがった回」
  const ep = prog?.episodes.find(e => e.id === selEp) ?? prog?.episodes.find(e => e.has_project) ?? prog?.episodes[0] ?? null

  const open = async (id: string) => {
    if (!prog) return
    try { await onOpen(prog.id, id) } catch (e) { setErr(String((e as Error).message)) }
  }
  const pickProgram = (id: string) => {
    if (id === sel) setExpanded(x => ({ ...x, [id]: !x[id] }))
    else { setSel(id); setSelEp(null); setView('all'); setExpanded(x => ({ ...x, [id]: true })) }
  }

  return (
    <div className="lib">
      <div className="lib-frame frame">
        <nav className="lib-nav" aria-label="メニュー">
          <div className="lib-brand"><span className="lib-logo">{Icon.wave}</span><b>ライブラリ</b></div>
          <span className="lib-navlabel">番組</span>
          <div className="lib-progs">
            {libData?.programs.map(p => {
              const isSel = p.id === sel, isOpen = !!expanded[p.id]
              const busyN = p.episodes.filter(e => e.job).length
              const revN = p.episodes.filter(e => !e.job && openCount(e) > 0).length
              const mcs = (p.members ?? []).filter(m => m.role === 'mc').map(m => m.name)
              return (
                <div key={p.id} className="lib-prog">
                  <button className={`lib-progbtn${isSel ? ' sel' : ''}`} aria-expanded={isOpen} onClick={() => pickProgram(p.id)}>
                    <span className="lib-tile" style={{ background: coverOf(p.name) }} aria-hidden="true">{initial(p.name)}</span>
                    <span className="lib-progtext"><b>{p.name}</b><small>{p.episodes.length} 回{mcs.length ? ` ・ ${mcs.join('・')}` : ''}</small></span>
                    <span className={`lib-chev${isOpen ? ' open' : ''}`}>{Icon.chev}</span>
                  </button>
                  {isOpen && (
                    <div className="lib-sub">
                      {([['busy', '処理中', Icon.clock, busyN, ''], ['review', '要確認', Icon.warn, revN, 'warn'], ['media', 'BGM・声紋', Icon.note, 0, ''], ['settings', '番組の設定', Icon.gear, 0, '']] as const).map(([v, label, icon, n, tone]) => (
                        <button key={v} className={`lib-subbtn${isSel && view === v ? ' on' : ''}`} aria-pressed={isSel && view === v}
                          onClick={() => { if (!isSel) { setSel(p.id); setSelEp(null) } setView(isSel && view === v ? 'all' : v) }}>
                          {icon}<span>{label}</span>{n > 0 && <span className={`lib-badge ${tone}`}>{n}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <button className="lib-add" onClick={() => setAdding(true)}>＋ 番組を追加する</button>
        </nav>

        <section className="lib-main" aria-label="回の一覧（素材をドロップすると新しい回）">
          {err && <div className="lib-err" role="alert" onClick={() => setErr('')}>{err}</div>}
          {!prog ? <div className="center">{libData ? '左下の「番組を追加する」から番組を作ってください' : '読み込み中…'}</div>
            : view === 'media' || view === 'settings'
              ? <Settings key={`${prog.id}-${view}`} prog={prog} part={view} onSaved={reload} onBack={() => setView('all')} />
              : <Episodes prog={prog} current={current} view={view} selected={ep?.id ?? null} onSelect={setSelEp} onRefresh={reload}
                  player={player} onPlay={e => player.load(prog.id, e.id, e.duration ?? 0, true)} />}
        </section>

        <aside className="lib-side" aria-label="選んだ回">
          {prog && ep ? <EpisodeSide prog={prog} ep={ep} player={player} onOpen={() => void open(ep.id)} onRefresh={reload} />
            : <div className="center lib-empty">回を選ぶと、ここに様子と文字起こしが出ます</div>}
        </aside>
      </div>
      {adding && <AddProgram onClose={() => setAdding(false)} onCreated={async id => { setAdding(false); await reload(); setSel(id); setSelEp(null); setView('all') }} />}
    </div>
  )
}

// ---------------------------------------------------------------- 真ん中：回の一覧・ドロップ・再生バー

interface Pending { files: File[]; date: string; folder: string | null; skipped: string[] }
type Player = NowPlaying

function Episodes({ prog, current, view, selected, onSelect, onRefresh, player, onPlay }: {
  prog: lib.ProgramEntry; current: lib.Current | null; view: View; selected: string | null
  onSelect: (id: string) => void; onRefresh: () => Promise<void>; player: Player; onPlay: (e: lib.Episode) => void
}) {
  const [over, setOver] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const busy = prog.episodes.some(e => e.job)
  useEffect(() => { setFilter(view === 'busy' ? 'busy' : view === 'review' ? 'review' : 'all') }, [view])

  // 処理中・順番待ちがあるあいだは、2秒ごとに一覧を読み直す
  useEffect(() => {
    if (!busy) return
    const id = window.setInterval(() => { void onRefresh() }, 2000)
    return () => window.clearInterval(id)
  }, [busy, onRefresh])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setOver(false); setErr('')
    const d = await collectDropped(e.dataTransfer)
    if (!d.files.length) { setErr('音声の素材（WAV・FLAC・AIFF）が見つかりませんでした'); return }
    setPending({ files: d.files, folder: d.folder, skipped: d.skipped, date: guessDate([d.folder, ...d.files.map(f => f.name)]) ?? today() })
  }
  const create = async () => {
    if (!pending) return
    if (!/^\d{8}$/.test(pending.date)) { setErr('日付は 20261204 のように8桁で入れてください'); return }
    if (pending.files.length < 2) { setErr('素材は話す人ごとに2本以上必要です'); return }
    try { await lib.createEpisode(prog.id, pending.date, pending.files); setPending(null); await onRefresh() } catch (e) { setErr(String((e as Error).message)) }
  }

  const mcs = (prog.members ?? []).filter(m => m.role === 'mc').map(m => m.name)
  const shown = prog.episodes.filter(e => {
    if (q && !`${e.title ?? ''} ${e.id} ${fmtDate(e.id)}`.toLowerCase().includes(q.toLowerCase())) return false
    if (filter === 'busy') return !!e.job
    if (filter === 'review') return !e.job && openCount(e) > 0
    if (filter === 'exported') return !!e.exported && !e.job
    return true
  })
  const playEp = player.st?.prog === prog.id ? prog.episodes.find(e => e.id === player.st?.ep) ?? null : null

  return (
    <div className={`lib-drop${over ? ' over' : ''}`}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false) }}
      onDrop={onDrop}>
      <label className="lib-search">{Icon.search}<span className="sr">回を検索</span>
        <input type="search" placeholder="回を検索" value={q} onChange={e => setQ(e.target.value)} />
      </label>
      <div className="lib-head">
        <h1>{prog.name}</h1>
        <span>{mcs.join('・') || 'メンバー未登録'} ・ {prog.episodes.length} 回 ・ 新しい順</span>
      </div>
      <div className="lib-filters" role="group" aria-label="絞り込み">
        {([['all', 'すべて'], ['review', '要確認'], ['busy', '処理中'], ['exported', '書き出し済み']] as const).map(([k, label]) => (
          <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      {err && <div className="lib-err" role="alert" onClick={() => setErr('')}>{err}</div>}

      <div className="lib-eps">
        {shown.map(e => <EpisodeCard key={e.id} prog={prog} ep={e} sel={e.id === selected} cur={current?.program === prog.id && current.episode === e.id}
          playing={player.st?.prog === prog.id && player.st.ep === e.id && player.st.playing}
          canPlay={player.canPlay(prog.id, e.id, !!e.exported)} onSelect={() => onSelect(e.id)} onPlay={() => (player.st?.prog === prog.id && player.st.ep === e.id ? player.toggle() : onPlay(e))} onRefresh={onRefresh} />)}
        {!shown.length && <div className="lib-none">{prog.episodes.length ? '当てはまる回がありません' : 'まだ回がありません'}</div>}
      </div>
      <div className="lib-hint">{Icon.upload}素材のフォルダやファイルを、この欄のどこにでもドロップすると新しい回を作ります</div>
      <label className="lib-pick">ファイルを選ぶ<input type="file" multiple accept=".wav,.flac,.aif,.aiff,audio/wav" hidden onChange={e => {
        const files = [...(e.target.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
        if (files.length) setPending({ files, folder: null, skipped: [], date: guessDate(files.map(f => f.name)) ?? today() })
        e.target.value = ''
      }} /></label>

      {playEp && <PlayerBar prog={prog} ep={playEp} player={player} />}

      {over && (
        <div className="lib-overlay" aria-hidden="true">
          <span className="lib-overicon">{Icon.upload}</span>
          <b>ここで離すと新しい回を作ります</b>
          <span>確認のあと、同期・ノイズ除去・話者の名前付け・文字起こしまで自動</span>
        </div>
      )}

      {pending && (
        <div className="lib-scrim" role="dialog" aria-label="新しい回を作る">
          <div className="lib-modal">
            <h2>この素材で新しい回を作りますか？</h2>
            <div className="lib-muted">{prog.name}{pending.folder ? ` ・ フォルダ「${pending.folder}」` : ''}</div>
            <ul className="lib-files">{pending.files.map(f => <li key={f.name}><span>{f.name}</span><span className="lib-muted">{(f.size / 1e6).toFixed(0)} MB</span></li>)}</ul>
            {pending.skipped.length > 0 && <div className="lib-muted">音声ではないので使わないもの：{pending.skipped.slice(0, 5).join('、')}{pending.skipped.length > 5 ? ` ほか${pending.skipped.length - 5}件` : ''}</div>}
            <label className="lib-field"><span>日付</span><input value={pending.date} inputMode="numeric" aria-label="日付（8桁）"
              onChange={e => setPending({ ...pending, date: e.target.value.replace(/\D/g, '').slice(0, 8) })} /><span className="lib-muted">{fmtDate(pending.date)}</span></label>
            <div className="lib-muted">話す人の名前は、登録した声紋から自動で付けます（近い人がいなければ「ゲスト」）。{busy ? '今ほかの回を処理中なので、終わったあとに始めます。' : ''}</div>
            {err && <div className="lib-err">{err}</div>}
            <div className="lib-actions"><button className="lib-btn" onClick={() => { setPending(null); setErr('') }}>やめる</button><button className="lib-btn primary" onClick={create}>作成</button></div>
          </div>
        </div>
      )}
    </div>
  )
}

function EpisodeCard({ prog, ep, sel, cur, playing, canPlay, onSelect, onPlay, onRefresh }: {
  prog: lib.ProgramEntry; ep: lib.Episode; sel: boolean; cur: boolean; playing: boolean; canPlay: boolean
  onSelect: () => void; onPlay: () => void; onRefresh: () => Promise<void>
}) {
  const n = openCount(ep)
  const job = ep.job
  const md = /^\d{8}$/.test(ep.id) ? `${ep.id.slice(4, 6)}.${ep.id.slice(6)}` : ep.id
  const kicker = lib.episodeKicker(ep, cur)
  const pct = Math.round((job?.progress ?? 0) * 100)
  return (
    <div className={`lib-ep${sel ? ' sel' : ''}`} onClick={onSelect} role="button" tabIndex={0} aria-pressed={sel}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}>
      <div className="lib-cover" style={{ background: coverOf(ep.id) }} aria-hidden="true">
        <span className="ring" />
        {canPlay && !job && (
          <button className="lib-coverplay" aria-label={playing ? '一時停止' : `${ep.title ?? ep.id} を聴く`} onClick={e => { e.stopPropagation(); onPlay() }}>{playing ? Icon.pause : Icon.play}</button>
        )}
        <b>{md}</b><small>{ep.id.slice(0, 4)}</small>
      </div>
      <div className="lib-epinfo">
        <span className="lib-kicker">{kicker}</span>
        <b>{ep.title ?? ep.id}</b>
        <span className="lib-meta">{[ep.duration ? fmtDur(ep.duration) : null, ep.exported ? `MP3 ${(ep.exported.size / 1e6).toFixed(1)} MB` : null].filter(Boolean).join(' ・ ') || fmtDate(ep.id)}</span>
        {job?.state === 'running' && (
          <div className="lib-progress">
            <div className="track"><div className="fill" style={{ width: `${pct}%` }}><span className="shim" /></div></div>
            <span>{lib.progressLabel(job)}</span>
          </div>
        )}
      </div>
      <div className="lib-epchip">
        {job?.state === 'running' && <span className="lib-chip busy"><span className="spin" aria-hidden="true" />{job.remaining != null ? `残り約 ${fmtRemain(job.remaining)}` : '見積もり中'}</span>}
        {job?.state === 'queued' && <span className="lib-chip busy">{job.position ?? '?'} 番目
          <button className="lib-link" onClick={e => { e.stopPropagation(); void lib.cancelJob(prog.id, ep.id).then(onRefresh) }}>取り消す</button></span>}
        {!job && n > 0 && <span className="lib-chip warn">要確認 {n}</span>}
        {!job && n === 0 && ep.has_project && <span className="lib-chip ok">{ep.exported ? '完成' : '編集中'}</span>}
      </div>
    </div>
  )
}

function PlayerBar({ prog, ep, player }: { prog: lib.ProgramEntry; ep: lib.Episode; player: Player }) {
  const st = player.st!
  const dur = st.dur || ep.duration || 0
  const frac = dur ? Math.min(1, st.t / dur) : 0
  const mcs = (prog.members ?? []).filter(m => m.role === 'mc').map(m => m.name)
  const seekAt = (e: React.MouseEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); player.seek(((e.clientX - r.left) / r.width) * dur) }
  return (
    <div className="lib-player" role="region" aria-label="再生中">
      <div className="lib-pinfo">
        <div className="lib-pcover" style={{ background: coverOf(ep.id) }} aria-hidden="true">{/^\d{8}$/.test(ep.id) ? `${ep.id.slice(4, 6)}.${ep.id.slice(6)}` : ''}</div>
        <div><b>{ep.title ?? ep.id}</b><small>{prog.name}{mcs.length ? ` ・ ${mcs.join('・')}` : ''}</small></div>
      </div>
      <div className="lib-pctl">
        <div className="lib-pbtns">
          <button aria-label="15秒戻る" onClick={() => player.skip(-15)}>{Icon.back15}</button>
          <button className="lib-pplay" aria-label={st.playing ? '一時停止' : '再生'} onClick={player.toggle}>{st.playing ? Icon.pause : Icon.play}</button>
          <button aria-label="15秒進む" onClick={() => player.skip(15)}>{Icon.fwd15}</button>
        </div>
        <div className="lib-pseek">
          <span>{fmtClock(st.t)}</span>
          <div className="lib-ptrack" role="slider" aria-label="再生位置" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(st.t)} tabIndex={0}
            onClick={seekAt} onKeyDown={e => { if (e.key === 'ArrowLeft') player.skip(-5); if (e.key === 'ArrowRight') player.skip(5) }}>
            <div className="fill" style={{ width: `${frac * 100}%` }} /><div className="knob" style={{ left: `${frac * 100}%` }} />
          </div>
          <span>{fmtClock(dur)}</span>
        </div>
      </div>
      <div className="lib-pextra">
        <button className="lib-rate" aria-label="再生速度" disabled={player.live} title={player.live ? '編集中の音は等速で鳴らします' : undefined} onClick={player.changeRate}>{player.live ? 1 : player.rate}x</button>
        {Icon.vol}
        <input className="lib-vol" type="range" min={0} max={1} step={0.01} value={player.live ? 1 : player.vol} disabled={player.live} title={player.live ? '編集中の音の大きさは編集画面のマスターで変えます' : undefined} aria-label="音量" onChange={e => player.changeVol(Number(e.target.value))} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 右：要確認（メモ・確認した・Claude に渡す）

const LEARN_TIP: Record<string, string> = {
  weak_match: '判定どおりの人なら、この回の声でその人の声紋を強めます',
  guest: 'ゲストでよければ確認した、を押してください',
}

/** 文をクリップボードへ。使えないときは古いやり方も試す。できたら true */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { /* 下へ */ }
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  try { return document.execCommand('copy') } catch { return false } finally { ta.remove() }
}

function Review({ prog, ep, canSeek, onSeek, onRefresh }: {
  prog: lib.ProgramEntry; ep: lib.Episode; canSeek: boolean; onSeek: (t: number) => void; onRefresh: () => Promise<void>
}) {
  const all = (ep.review ?? []).map((f, i) => ({ f, i }))
  const open = all.filter(x => !x.f.resolved), done = all.filter(x => x.f.resolved)
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ text: string; tone: '' | 'bad' } | null>(null)
  useEffect(() => { setNotes({}); setMsg(null) }, [prog.id, ep.id])
  const noteOf = (i: number, f: lib.Finding) => notes[i] ?? f.note ?? ''

  const send = async (items: lib.ReviewItem[], i: number) => {
    setBusy(i)
    try {
      const r = await lib.updateReview(prog.id, ep.id, items)
      if (r.learned.length) setMsg({ text: r.learned.join('\n'), tone: '' })
      await onRefresh()
      setNotes(n => { const x = { ...n }; delete x[i]; return x })
    } catch (e) {
      setMsg({ text: String((e as Error).message), tone: 'bad' })
    } finally { setBusy(null) }
  }
  const saveNote = (i: number, f: lib.Finding) => {
    const v = notes[i]
    if (v === undefined || v === (f.note ?? '')) return
    void send([{ index: i, note: v }], i)
  }
  const [manual, setManual] = useState<string | null>(null) // コピーできなかったときに、手で選んでコピーする用
  const handoff = async () => {
    let text = ''
    try { text = await lib.getReviewHandoff(prog.id, ep.id) } catch (e) {
      setMsg({ text: `まとめを作れませんでした：${String((e as Error).message)}`, tone: 'bad' }); return
    }
    if (await copyText(text)) { setManual(null); setMsg({ text: 'コピーしました。Claude Code の入力欄に貼り付けて送ってください', tone: '' }) }
    else { setManual(text); setMsg(null) }
  }

  return (
    <div className={`lib-review${open.length ? '' : ' calm'}`}>
      <div className="lib-revhead">
        <b>{open.length ? '確認が必要なところ' : 'すべて確認しました'}</b>
        <button className="lib-handoff" onClick={() => void handoff()} title="要確認とメモをまとめてコピーします。Claude Code に貼ると、そのまま対応を頼めます">{Icon.copy}Claude に渡す</button>
      </div>
      {open.map(({ f, i }) => (
        <div key={i} className="lib-finding">
          <button className="lib-time" disabled={!canSeek || f.time == null} onClick={() => f.time != null && onSeek(f.time)}>{f.time != null ? fmtClock(f.time) : '—'}</button>
          <div className="lib-fbody">
            <span>{f.message}</span>
            {(f.hints ?? []).map((h, k) => <small key={k} className="lib-hint">前回のメモ（{fmtDate(h.episode)}）：{h.note}</small>)}
            <textarea className="lib-note" rows={1} placeholder="メモ（Claude に伝えたいこと）" aria-label="メモ" value={noteOf(i, f)}
              onChange={e => setNotes(n => ({ ...n, [i]: e.target.value }))} onBlur={() => saveNote(i, f)} />
          </div>
          <button className="lib-confirm" disabled={busy === i} title={LEARN_TIP[f.kind] ?? '確認したことと、メモを記録します（次の回の参考にします）'}
            onClick={() => void send([{ index: i, resolved: true, note: noteOf(i, f) }], i)}>{busy === i ? '記録中…' : '確認した'}</button>
        </div>
      ))}
      {done.length > 0 && (
        <details className="lib-done">
          <summary>確認済み {done.length} 件</summary>
          {done.map(({ f, i }) => (
            <div key={i} className="lib-finding done">
              <span className="lib-time">{f.time != null ? fmtClock(f.time) : '—'}</span>
              <div className="lib-fbody">
                <span>{f.message}</span>
                <textarea className="lib-note" rows={1} placeholder="メモ" aria-label="メモ" value={noteOf(i, f)}
                  onChange={e => setNotes(n => ({ ...n, [i]: e.target.value }))} onBlur={() => saveNote(i, f)} />
              </div>
              <span />
            </div>
          ))}
        </details>
      )}
      {manual != null && (
        <div className="lib-manual">
          <span className="lib-muted">自動でコピーできませんでした。下の文を選んでコピーし（⌘A → ⌘C）、Claude Code に貼ってください</span>
          <textarea readOnly value={manual} rows={6} onFocus={e => e.currentTarget.select()} aria-label="Claude に渡す文" />
          <button className="lib-link" onClick={() => setManual(null)}>閉じる</button>
        </div>
      )}
      {msg && <div className={`lib-revmsg ${msg.tone}`} role="status" onClick={() => setMsg(null)}>{msg.text}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- 右：選んだ回の様子・要確認・文字起こし

function EpisodeSide({ prog, ep, player, onOpen, onRefresh }: { prog: lib.ProgramEntry; ep: lib.Episode; player: Player; onOpen: () => void; onRefresh: () => Promise<void> }) {
  const [tr, setTr] = useState<lib.EpisodeTranscript | null | 'none'>(null)
  useEffect(() => {
    let alive = true
    setTr(null)
    if (!ep.has_transcript || ep.job) { setTr('none'); return }
    lib.getEpisodeTranscript(prog.id, ep.id).then(t => { if (alive) setTr(t) }, () => { if (alive) setTr('none') })
    return () => { alive = false }
  }, [prog.id, ep.id, ep.has_transcript, ep.job])

  const lines = tr && tr !== 'none' ? tr.lines : []
  const speakers = useMemo(() => [...new Set(lines.map(l => l.speaker))], [lines])
  const colorOf = (s: string) => SPEAKER[Math.max(0, speakers.indexOf(s)) % SPEAKER.length]
  const canPlay = player.canPlay(prog.id, ep.id, !!ep.exported)
  const isThis = player.st?.prog === prog.id && player.st.ep === ep.id
  const t = isThis ? player.st!.t : -1
  const nowIdx = isThis ? lines.findIndex(l => t >= l.start && t < l.end) : -1
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (nowIdx < 0 || !player.st?.playing) return
    listRef.current?.querySelector<HTMLElement>(`[data-i="${nowIdx}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [nowIdx, player.st?.playing])
  const review = (ep.review ?? []).map((f, i) => ({ f, i })).filter(x => !x.f.resolved)
  const kicker = ep.job ? '処理中' : ep.exported ? 'MP3 書き出し済み' : ep.has_project ? 'まだ書き出していません' : '素材のみ'

  return (
    <>
      <div className="lib-sidehead"><span>{fmtDate(ep.id)} ・ {kicker}</span><b>{ep.title ?? ep.id}</b></div>
      <div className="lib-stats">
        <div><span>長さ</span><b>{ep.duration ? fmtClock(ep.duration) : '—'}</b></div>
        <div><span>MP3</span><b>{ep.exported ? `${(ep.exported.size / 1e6).toFixed(1)} MB` : '—'}</b></div>
        <div><span>話す人</span><b>{speakers.length ? `${speakers.length} 人` : '—'}</b></div>
        <div><span>要確認</span><b className={review.length ? 'warn' : ''}>{ep.has_project ? (review.length ? `${review.length} 件` : 'なし') : '—'}</b></div>
      </div>
      {(ep.review ?? []).length > 0 && (
        <Review prog={prog} ep={ep} onRefresh={onRefresh}
          canSeek={player.canPlay(prog.id, ep.id, !!ep.exported)} onSeek={t => player.load(prog.id, ep.id, ep.duration ?? 0, true, t)} />
      )}
      <b className="lib-trhead">文字起こし</b>
      <div className="lib-lines" ref={listRef}>
        {tr === null && <div className="lib-muted">読み込み中…</div>}
        {tr === 'none' && <div className="lib-muted">{ep.job ? '処理が終わると出ます' : 'この回の文字起こしはまだありません'}</div>}
        {lines.map((l, i) => (
          <button key={i} data-i={i} className={`lib-line${i === nowIdx ? ' now' : ''}`} disabled={!canPlay}
            title={canPlay ? 'ここから聴く' : undefined} onClick={() => player.load(prog.id, ep.id, ep.duration ?? 0, true, l.start)}>
            <span className="av" style={{ background: colorOf(l.speaker) }} aria-hidden="true">{initial(l.speaker)}</span>
            <span className="tx"><small>{l.speaker}</small><span>{l.text}</span></span>
            <span className="tm">{fmtClock(l.start)}</span>
          </button>
        ))}
      </div>
      <button className="lib-open" disabled={!ep.has_project || !!ep.job} onClick={onOpen}>{Icon.edit}編集画面で開く</button>
    </>
  )
}

// ---------------------------------------------------------------- 番組を追加する

function AddProgram({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [bgm, setBgm] = useState<Record<'op' | 'ed', File | null>>({ op: null, ed: null })
  const [members, setMembers] = useState<string[]>([''])
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])
  const submit = async () => {
    const nm = name.trim()
    if (!nm) { setErr('番組名を入れてください'); return }
    setSaving(true); setErr('')
    try {
      const p = await lib.createProgram(nm)
      for (const role of ['op', 'ed'] as const) { const f = bgm[role]; if (f) await lib.uploadBgm(p.id, role, f) }
      const names = [...new Set(members.map(m => m.trim()).filter(Boolean))]
      if (names.length) {
        const full = await fetch(`/api/programs/${encodeURIComponent(p.id)}`).then(r => r.json() as Promise<lib.Program>)
        await lib.saveProgram(p.id, { ...full, members: names.map(n => ({ name: n, role: 'mc', voiceprint: null })) })
      }
      onCreated(p.id)
    } catch (e) { setErr(String((e as Error).message)); setSaving(false) }
  }
  const BgmSlot = ({ role, label }: { role: 'op' | 'ed'; label: string }) => (
    <label className={`lib-bgm${bgm[role] ? ' has' : ''}`}
      onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f) setBgm(b => ({ ...b, [role]: f })) }}>
      <small>{label}</small><b>{bgm[role] ? `♪ ${bgm[role]!.name}` : 'ドロップ、または押して選ぶ'}</b>
      <input type="file" accept="audio/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) setBgm(b => ({ ...b, [role]: f })); e.target.value = '' }} />
    </label>
  )
  return (
    <div className="lib-scrim" role="dialog" aria-label="番組を追加する" onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <div className="lib-modal wide">
        <div className="lib-modalhead"><h2>番組を追加する</h2><button className="lib-x" aria-label="閉じる" onClick={onClose} disabled={saving}>✕</button></div>
        <label className="lib-col"><span>番組名</span><input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="例：岡田山ラジオ" /></label>
        <div className="lib-col"><span>BGM（あとから「BGM・声紋」でも登録できます）</span>
          <div className="lib-bgms"><BgmSlot role="op" label="オープニング" /><BgmSlot role="ed" label="エンディング" /></div>
        </div>
        <div className="lib-col"><span>話者</span>
          {members.map((m, i) => (
            <div key={i} className="lib-member">
              <span className="av" style={{ background: SPEAKER[i % SPEAKER.length] }} aria-hidden="true">{m.trim() ? initial(m) : '?'}</span>
              <input value={m} placeholder="名前（例：青木さん）" aria-label={`話者 ${i + 1} の名前`} onChange={e => setMembers(ms => ms.map((x, k) => (k === i ? e.target.value : x)))} />
              <span className="lib-muted">声紋 まだなし</span>
              {members.length > 1 && <button className="lib-x sm" aria-label="この話者を外す" onClick={() => setMembers(ms => ms.filter((_, k) => k !== i))}>✕</button>}
            </div>
          ))}
          <button className="lib-dashed" onClick={() => setMembers(ms => [...ms, ''])}>＋ 話者を追加</button>
          <span className="lib-muted">声紋を登録すると、次の回から話す人の名前が自動で付きます。登録は Claude Code に「12/4 の青木さんの声を声紋に登録して」のように頼んでください。</span>
        </div>
        {err && <div className="lib-err">{err}</div>}
        <div className="lib-actions"><button className="lib-btn" onClick={onClose} disabled={saving}>やめる</button><button className="lib-btn primary" onClick={submit} disabled={saving}>{saving ? '追加中…' : '追加する'}</button></div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 番組の設定・BGM と声紋

function Settings({ prog, part, onSaved, onBack }: { prog: lib.ProgramEntry; part: 'media' | 'settings'; onSaved: () => void; onBack: () => void }) {
  const [draft, setDraft] = useState<lib.Program>(() => ({ name: prog.name, preset: prog.preset, deliver_dir: prog.deliver_dir, bgm: prog.bgm ?? {}, members: prog.members ?? [], format: prog.format, version: prog.version }))
  const [presets, setPresets] = useState<string[]>([])
  const [msg, setMsg] = useState('')
  useEffect(() => { setDraft({ name: prog.name, preset: prog.preset, deliver_dir: prog.deliver_dir, bgm: prog.bgm ?? {}, members: prog.members ?? [], format: prog.format, version: prog.version }) }, [prog])
  useEffect(() => { listPresets().then(l => setPresets(l.map(x => x.name)), () => {}) }, [])
  const save = async () => {
    try { await lib.saveProgram(prog.id, draft); setMsg('保存しました'); onSaved() } catch (e) { setMsg(`保存できませんでした：${(e as Error).message}`) }
  }
  const members = draft.members ?? []
  const setMember = (i: number, m: lib.Member) => setDraft({ ...draft, members: members.map((x, k) => (k === i ? m : x)) })
  return (
    <div className="lib-settings">
      <div className="lib-head"><h1>{part === 'media' ? 'BGM・声紋' : '番組の設定'}</h1><span>{prog.name}</span></div>
      {part === 'settings' && (
        <section className="lib-card">
          <label className="lib-field"><span>名前</span><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label className="lib-field"><span>いつもの設定</span>
            <select value={draft.preset ?? ''} onChange={e => setDraft({ ...draft, preset: e.target.value || null })}>
              <option value="">なし</option>
              {presets.map(n => <option key={n} value={n}>{n}</option>)}
            </select></label>
          <label className="lib-field"><span>完成版のコピー先フォルダ</span>
            <input value={draft.deliver_dir ?? ''} placeholder="~/Library/CloudStorage/GoogleDrive-…/マイドライブ/岡田山ラジオ 完成版" onChange={e => setDraft({ ...draft, deliver_dir: e.target.value || null })} /></label>
          <span className="lib-muted">書き出すたびに MP3 と文字起こしをここへコピー（Google Drive のフォルダなど）。空なら使わない</span>
        </section>
      )}
      {part === 'media' && (
        <>
          <section className="lib-card">
            <h2>BGM</h2>
            {['op', 'ed'].map(role => (
              <div key={role} className="lib-field">
                <span>{role === 'op' ? 'オープニング' : 'エンディング'}</span>
                <span className="lib-mono">{draft.bgm?.[role]?.split('/').pop() ?? '未登録'}</span>
                <label className="lib-btn">差し替え<input type="file" accept="audio/*" hidden onChange={async e => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  try { const p = await lib.uploadBgm(prog.id, role, f); setDraft({ ...draft, bgm: p.bgm ?? draft.bgm }); setMsg('BGM を登録しました'); onSaved() } catch (er) { setMsg(String((er as Error).message)) }
                }} /></label>
              </div>
            ))}
          </section>
          <section className="lib-card">
            <h2>話者と声紋</h2>
            <span className="lib-muted">声紋の登録は Claude Code に「12/4 の青木さんの声を声紋に登録して」のように頼んでください。登録した人の声に十分近いトラックには、新しい回でその名前と、いつもの設定の音質が自動でつきます。近い人がいなければ「ゲスト」になります。</span>
            {members.map((m, i) => (
              <div key={i} className="lib-member">
                <span className="av" style={{ background: SPEAKER[i % SPEAKER.length] }} aria-hidden="true">{initial(m.name)}</span>
                <input value={m.name} onChange={e => setMember(i, { ...m, name: e.target.value })} aria-label="名前" />
                <select value={m.role} onChange={e => setMember(i, { ...m, role: e.target.value })} aria-label="役">
                  <option value="mc">MC</option><option value="guest">ゲスト</option></select>
                {m.enrolled || m.voiceprint ? <span className="lib-chip ok">声紋あり</span> : <span className="lib-muted">声紋 まだなし</span>}
                <button className="lib-x sm" aria-label={`${m.name}を削除`} onClick={async () => {
                  if (!window.confirm(`${m.name} を削除します（声紋も消えます）。よろしいですか？`)) return
                  try { await lib.deleteMember(prog.id, m.name); onSaved() } catch { setDraft({ ...draft, members: members.filter((_, k) => k !== i) }) }
                }}>✕</button>
              </div>
            ))}
            <button className="lib-dashed" onClick={() => setDraft({ ...draft, members: [...members, { name: '新しい人', role: 'mc', voiceprint: null }] })}>＋ 話者を追加</button>
          </section>
        </>
      )}
      <div className="lib-actions"><button className="lib-btn" onClick={onBack}>回の一覧へ</button><button className="lib-btn primary" onClick={save}>保存</button>{msg && <span className="lib-muted">{msg}</span>}</div>
    </div>
  )
}
