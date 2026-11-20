// 台本：クリックで移動して文字を直す。ドラッグ・Shift・⌘クリックで複数選んでカット。カット済みの行はクリックで戻す。
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { lineTime } from './editops'
import type { Player } from './player'
import { usePlayhead } from './playhead'
import { formatTime, isCut, outToRef } from './timeline'
import type { Project, Utterance } from './types'

interface Props {
  project: Project; player: Player; lines: Utterance[]; colors: Record<string, string>
  selected: number[]; setSelected: (s: number[]) => void
  onSeekRef: (t: number) => void
  onEditText: (line: number, text: string) => void
  onRestore: (line: number) => void
  onCut: () => void
}

export function ScriptPanel(p: Props) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const drag = useRef<{ anchor: number; moved: boolean } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const segs = p.project.edit.segments

  // 再生位置の行（基準時刻で、始まりが再生位置以前の最後の行）
  const now = usePlayhead(p.player, t => {
    const r = outToRef(p.project.edit, t)
    if (r == null) return -1
    let k = -1
    for (let i = 0; i < p.lines.length; i++) { if (p.lines[i].start <= r) k = i; else break }
    return k
  })
  const playing = usePlayhead(p.player, (_t, pl) => pl)
  useEffect(() => {
    if (!playing || editing != null || now < 0) return
    // 光っている行が一覧の真ん中あたりに来るよう、なめらかに送る
    listRef.current?.querySelector(`[data-i="${now}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [now, playing, editing])

  useEffect(() => {
    const up = () => { drag.current = null }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const range = (a: number, b: number) => Array.from({ length: Math.abs(b - a) + 1 }, (_, k) => Math.min(a, b) + k)

  const onDown = (e: React.MouseEvent, i: number) => {
    if (editing === i) return
    if (e.shiftKey && p.selected.length) { p.setSelected(range(p.selected[0], i)); e.preventDefault(); return }
    if (e.metaKey || e.ctrlKey) {
      p.setSelected(p.selected.includes(i) ? p.selected.filter(k => k !== i) : [...p.selected, i]); e.preventDefault(); return
    }
    drag.current = { anchor: i, moved: false }
  }
  const onEnter = (i: number) => {
    const d = drag.current
    if (!d || i === d.anchor && !d.moved) return
    d.moved = true
    setEditing(null)
    p.setSelected(range(d.anchor, i))
  }
  const onUp = (e: React.MouseEvent, i: number) => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved || e.shiftKey || e.metaKey || e.ctrlKey) return
    if (editing === i) return
    const u = p.lines[i]
    // 選んである1行をもう一度クリック → 選択を外す
    if (p.selected.length === 1 && p.selected[0] === i) { p.setSelected([]); return }
    if (isCut(segs, u.start, u.end)) { p.onRestore(i); p.setSelected([]); return }
    p.onSeekRef(u.start)
    p.setSelected([i])
    setEditing(i)
  }

  const q = query.trim()
  return (
    <aside className="aside">
      <div className="aside-head">
        <h2>台本 <span className="hint">（フィラーなし・{p.lines.length}発言）</span></h2>
        <input className="search" type="search" placeholder="台本を検索" aria-label="台本を検索" value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      <div className="lines" ref={listRef}>
        {p.lines.map((u, i) => (q && !u.script.includes(q)) ? null : (
          <Line key={i} i={i} u={u} color={p.colors[u.source] ?? '#888'} cut={isCut(segs, u.start, u.end)}
            now={i === now} playing={playing} sel={p.selected.includes(i)} editing={editing === i}
            onDown={onDown} onEnter={onEnter} onUp={onUp} onTime={() => p.onSeekRef(u.start)}
            onDone={text => {
              setEditing(null)
              // 編集を終えたら選択も外す（青いまま残らないように）
              if (p.selected.length === 1 && p.selected[0] === i) p.setSelected([])
              if (text != null && text !== u.script) p.onEditText(i, text)
            }} />
        ))}
      </div>
      <div className="aside-foot">
        <div className="hint" style={{ lineHeight: 1.7 }}>
          文をクリック：そこへ移動して文字を直す（音声は変わりません）<br />
          ドラッグ・Shift・⌘クリックで複数選択 → カット（Delete キーでも）。カット済みの文はクリックで戻す
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn danger" disabled={!p.selected.length} onClick={p.onCut}>選んだ文をカット（{p.selected.length}）</button>
          <button className="btn" disabled={!p.selected.length} onClick={() => p.setSelected([])}>選択を外す</button>
        </div>
      </div>
    </aside>
  )
}

interface LineProps {
  i: number; u: Utterance; color: string; cut: boolean; now: boolean; playing: boolean; sel: boolean; editing: boolean
  onDown: (e: React.MouseEvent, i: number) => void; onEnter: (i: number) => void; onUp: (e: React.MouseEvent, i: number) => void
  onTime: () => void; onDone: (text: string | null) => void
}

const Line = memo(function Line({ i, u, color, cut, now, playing, sel, editing, onDown, onEnter, onUp, onTime, onDone }: LineProps) {
  const cls = ['line', cut && 'cut', now && 'now', now && playing && 'playing', sel && 'sel'].filter(Boolean).join(' ')
  return (
    <div className={cls} data-i={i} onMouseDown={e => onDown(e, i)} onMouseEnter={() => onEnter(i)} onMouseUp={e => onUp(e, i)}>
      <button className="time mono" aria-label={`${formatTime(lineTime(u))} へ移動`}
        onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()} onClick={onTime}>{formatTime(lineTime(u))}</button>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div className="who"><span className="dot" style={{ background: color }} />{u.speaker}
          {cut && <span className="tag cut">カット済み・クリックで戻す</span>}</div>
        {editing ? <Editor initial={u.script} onDone={onDone} /> : <div className="text">{u.script}</div>}
      </div>
    </div>
  )
})

function Editor({ initial, onDone }: { initial: string; onDone: (t: string | null) => void }) {
  const [text, setText] = useState(initial)
  const done = useRef(false)
  const area = useRef<HTMLTextAreaElement>(null)
  // 文字の量に合わせて高さを変え、全部見えるようにする
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 4}px`
  }, [text])
  const finish = (t: string | null) => { if (done.current) return; done.current = true; onDone(t) }
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }} onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()}>
      <textarea ref={area} rows={1} autoFocus value={text} aria-label="発言の文字を編集"
        onFocus={e => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onChange={e => setText(e.target.value)}
        onBlur={() => finish(text)}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return // 日本語の変換中は確定しない
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(text.replace(/\n/g, '')) }
          else if (e.key === 'Escape') { e.preventDefault(); finish(null) }
        }} />
      <span className="hint">Enter で確定 ・ Esc で取り消し ・ 文字を直しても音声は変わりません</span>
    </label>
  )
}
