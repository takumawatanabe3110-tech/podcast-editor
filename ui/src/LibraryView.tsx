// 一覧画面：番組を選び、回（作成した音源）の一覧から開く。新しい回を作る。番組の BGM・MC・声紋を登録する。
import { useCallback, useEffect, useState } from 'react'
import { listPresets } from './api'
import * as lib from './library'

const fmtDur = (s?: number | null) => (s ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : '—')
const fmtDate = (id: string) => (/^\d{8}$/.test(id) ? `${id.slice(0, 4)}/${id.slice(4, 6)}/${id.slice(6)}` : id)
const today = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` }
const fmtRemain = (sec: number) => { const s = Math.max(1, Math.round(sec)); return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒` }

export function LibraryView({ current, onOpened }: { current: lib.Current | null; onOpened: () => void }) {
  const [libData, setLib] = useState<lib.Library | null>(null)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<string | null>(current?.program ?? null)
  const [tab, setTab] = useState<'episodes' | 'settings'>('episodes')
  const reload = useCallback(async () => {
    try { const l = await lib.getLibrary(); setLib(l); setSel(s => s ?? l.programs[0]?.id ?? null) } catch (e) { setErr(String((e as Error).message)) }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const prog = libData?.programs.find(p => p.id === sel) ?? null
  const open = async (ep: string) => {
    if (!prog) return
    try { await lib.openEpisode(prog.id, ep); onOpened() } catch (e) { setErr(String((e as Error).message)) }
  }
  const newProgram = async () => {
    const name = window.prompt('新しい番組の名前')?.trim()
    if (!name) return
    try { const p = await lib.createProgram(name); await reload(); setSel(p.id); setTab('settings') } catch (e) { setErr(String((e as Error).message)) }
  }

  return (
    <div className="libview">
      <aside className="libside">
        <h2>番組</h2>
        <ul className="proglist">
          {libData?.programs.map(p => (
            <li key={p.id}><button aria-pressed={p.id === sel} onClick={() => setSel(p.id)}>{p.name}<small>{p.episodes.length} 回</small></button></li>
          ))}
        </ul>
        <button className="btn" onClick={newProgram}>＋ 新しい番組</button>
        {libData && <div className="hint" title={libData.root}>保存先：{libData.root.split('/').slice(-2).join('/')}</div>}
      </aside>
      <main className="libmain">
        {err && <div className="status warn" onClick={() => setErr('')}>{err}</div>}
        {!prog ? <div className="center">{libData ? '番組を作ってください' : '読み込み中…'}</div> : (
          <>
            <div className="libhead">
              <h1>{prog.name}</h1>
              <div className="tabs" role="group" aria-label="表示">
                <button aria-pressed={tab === 'episodes'} onClick={() => setTab('episodes')}>回の一覧</button>
                <button aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>番組の設定</button>
              </div>
            </div>
            {tab === 'episodes'
              ? <Episodes prog={prog} current={current} onOpen={open} onCreated={async ep => { await reload(); await open(ep) }} />
              : <Settings prog={prog} onSaved={reload} />}
          </>
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------- 回の一覧と新しい回

function Episodes({ prog, current, onOpen, onCreated }: {
  prog: lib.ProgramEntry; current: lib.Current | null; onOpen: (ep: string) => void; onCreated: (ep: string) => void
}) {
  const [date, setDate] = useState(today())
  const [files, setFiles] = useState<File[]>([])
  const [job, setJob] = useState<{ ep: string; st: lib.JobStatus } | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!job || job.st.state !== 'running') return
    const id = window.setTimeout(async () => {
      try {
        const st = await lib.episodeStatus(prog.id, job.ep)
        setJob({ ep: job.ep, st })
        if (st.state === 'done') onCreated(job.ep)
      } catch { /* もう一度 */ setJob({ ...job }) }
    }, 1500)
    return () => window.clearTimeout(id)
  }, [job, prog.id, onCreated])
  const start = async () => {
    setErr('')
    if (!/^\d{8}$/.test(date)) { setErr('日付は 20261204 のように8桁で入れてください'); return }
    if (files.length < 1) { setErr('素材（WAV）を選んでください'); return }
    try {
      const r = await lib.createEpisode(prog.id, date, files)
      setJob({ ep: r.id ?? date, st: { state: 'running', progress: 0, stage: '素材を送りました' } })
    } catch (e) { setErr(String((e as Error).message)) }
  }
  return (
    <div className="eplist">
      <section className="newep fxpanel">
        <h2>新しい回を作る</h2>
        <div className="newrow">
          <label>日付<input value={date} onChange={e => setDate(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" aria-label="日付（8桁）" /></label>
          <label className="filepick">素材（WAV、話す人ごとに1本）
            <input type="file" multiple accept=".wav,audio/wav" onChange={e => setFiles([...(e.target.files ?? [])])} />
          </label>
          <button className="btn primary" disabled={job?.st.state === 'running'} onClick={start}>作成</button>
        </div>
        {files.length > 0 && <div className="hint">{files.map(f => f.name).join('、')}（声紋で話す人を見分けます。順番は気にしなくて大丈夫です）</div>}
        {job && (
          <div className={`status${job.st.state === 'error' ? ' warn' : ' busy'}`}>
            {job.st.state === 'running' && <span className="pbar"><span style={{ width: `${Math.round((job.st.progress ?? 0) * 100)}%` }} /></span>}
            {job.st.state === 'error' ? `作れませんでした：${job.st.message ?? ''}` : job.st.state === 'done' ? 'できました' : `${job.st.stage ?? '作成中'}${job.st.remaining != null ? `・残り約${fmtRemain(job.st.remaining)}` : ''}`}
          </div>
        )}
        {err && <div className="status warn">{err}</div>}
      </section>
      <table className="eptable">
        <thead><tr><th>日付</th><th>タイトル</th><th>長さ</th><th>書き出し</th><th /></tr></thead>
        <tbody>
          {prog.episodes.map(ep => (
            <tr key={ep.id} className={current?.program === prog.id && current.episode === ep.id ? 'cur' : ''}>
              <td className="mono">{fmtDate(ep.id)}</td>
              <td>{ep.title ?? ep.id}</td>
              <td>{fmtDur(ep.duration)}</td>
              <td>{ep.exported ? <span title={ep.exported.path}>MP3（{(ep.exported.size / 1e6).toFixed(1)} MB・{new Date(ep.exported.mtime * 1000).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）</span> : <span className="hint">まだ</span>}</td>
              <td>{ep.has_project ? <button className="btn" onClick={() => onOpen(ep.id)}>開く</button> : <span className="hint">作成中</span>}</td>
            </tr>
          ))}
          {!prog.episodes.length && <tr><td colSpan={5} className="hint">まだ回がありません</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------- 番組の設定（BGM・MC・声紋）

function Settings({ prog, onSaved }: { prog: lib.ProgramEntry; onSaved: () => void }) {
  const [draft, setDraft] = useState<lib.Program>(() => ({ name: prog.name, preset: prog.preset, bgm: prog.bgm ?? {}, members: prog.members ?? [], format: prog.format, version: prog.version }))
  const [presets, setPresets] = useState<string[]>([])
  const [msg, setMsg] = useState('')
  useEffect(() => { setDraft({ name: prog.name, preset: prog.preset, bgm: prog.bgm ?? {}, members: prog.members ?? [], format: prog.format, version: prog.version }) }, [prog])
  useEffect(() => { listPresets().then(l => setPresets(l.map(x => x.name)), () => {}) }, [])
  const save = async () => {
    try { await lib.saveProgram(prog.id, draft); setMsg('保存しました'); onSaved() } catch (e) { setMsg(`保存できませんでした：${(e as Error).message}`) }
  }
  const members = draft.members ?? []
  const setMember = (i: number, m: lib.Member) => setDraft({ ...draft, members: members.map((x, k) => (k === i ? m : x)) })
  return (
    <div className="settings">
      <section className="fxpanel">
        <h2>番組</h2>
        <label className="prow"><span>名前</span><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label className="prow"><span>いつもの設定</span>
          <select value={draft.preset ?? ''} onChange={e => setDraft({ ...draft, preset: e.target.value || null })}>
            <option value="">なし</option>
            {presets.map(n => <option key={n} value={n}>{n}</option>)}
          </select></label>
      </section>
      <section className="fxpanel">
        <h2>BGM</h2>
        {['op', 'ed'].map(role => (
          <div key={role} className="prow">
            <span>{role === 'op' ? 'OP（オープニング）' : 'ED（エンディング）'}</span>
            <span className="mono">{draft.bgm?.[role]?.split('/').pop() ?? '未登録'}</span>
            <label className="btn">差し替え<input type="file" accept="audio/*" hidden onChange={async e => {
              const f = e.target.files?.[0]
              if (!f) return
              try { const p = await lib.uploadBgm(prog.id, role, f); setDraft({ ...draft, bgm: p.bgm ?? draft.bgm }); setMsg('BGM を登録しました'); onSaved() } catch (er) { setMsg(String((er as Error).message)) }
            }} /></label>
          </div>
        ))}
      </section>
      <section className="fxpanel">
        <h2>MC・メンバーと声紋</h2>
        <div className="hint">声紋は、編集画面のトラック名の横の「声紋に登録」から作れます。登録した人の声に十分近いトラックには、新しい回でその名前と、いつもの設定の音質が自動でつきます。近い人がいなければ「ゲスト」になります。</div>
        <table className="eptable">
          <thead><tr><th>名前</th><th>役</th><th>声紋</th><th /></tr></thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={i}>
                <td><input value={m.name} onChange={e => setMember(i, { ...m, name: e.target.value })} aria-label="名前" /></td>
                <td><select value={m.role} onChange={e => setMember(i, { ...m, role: e.target.value })} aria-label="役">
                  <option value="mc">MC</option><option value="guest">ゲスト</option></select></td>
                <td>{m.voiceprint ? <span className="chip">登録済み</span> : <span className="hint">未登録</span>}</td>
                <td><button className="btn icon sm" aria-label={`${m.name}を削除`} title="削除" onClick={async () => {
                  if (!window.confirm(`${m.name} を削除します（声紋も消えます）。よろしいですか？`)) return
                  try { await lib.deleteMember(prog.id, m.name); onSaved() } catch { setDraft({ ...draft, members: members.filter((_, k) => k !== i) }) }
                }}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn" onClick={() => setDraft({ ...draft, members: [...members, { name: '新しい人', role: 'mc', voiceprint: null }] })}>＋ メンバー</button>
      </section>
      <div className="newrow"><button className="btn primary" onClick={save}>保存</button>{msg && <span className="status">{msg}</span>}</div>
    </div>
  )
}
