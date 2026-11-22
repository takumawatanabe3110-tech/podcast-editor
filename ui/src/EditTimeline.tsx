// 編集画面のタイムライン（一般的な編集ソフトの形）。時刻の軸は完成版の時刻で、カットした部分は詰めて見せない。
// - 声：波形の上をドラッグで範囲を選び Delete でカット／C で再生位置に切れ目／切れ目の端をドラッグして削る・戻す
//   左端のつまみで声全体（話し始め）の位置を動かす／音量の線をクリックで点を打ち、ドラッグで変える
// - BGM：本体をドラッグで位置、端で頭・終わりを削る（元の曲は残るので戻せる）、□でフェード、線をクリックで点
// - トラック名：書き換えると台本の名前も変わる。名前の欄の外をクリックするとエフェクトタブ
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { addKeyframe, clipEnd, clipGainDb, clipStart, moveEnd, moveKeyframe, moveStart, removeKeyframe, setFade } from './bgmops'
import { clamp } from './layout'
import { addPoint, curveDbAt, cutOutRange, movePoint, pieces, removePiece, setEdge, splitAt, type Piece } from './nle'
import { BGM_ID, type Player } from './player'
import { usePlayhead } from './playhead'
import { isDark, ink, useDark } from './theme'
import { fileTime, formatTime, rulerTicks } from './timeline'
import type { BgmClip, Keyframe, Peaks, Project, Utterance } from './types'

export interface OutView { start: number; span: number } // 出力時刻
export type ChangeOpts = { restart?: boolean }

interface Props {
  project: Project; utterances: Utterance[]; peaks: Record<string, Peaks>; player: Player
  view: OutView; setView: (v: OutView) => void; total: number; showRuby: boolean; setShowRuby?: (b: boolean) => void; colors: string[]
  refDur: (sid: string) => number
  onChange: (p: Project, group?: string, opts?: ChangeOpts) => void
  onOpenFx: (track: string) => void
  onRename: (sid: string, name: string) => void
}

type Sel =
  | { kind: 'range'; a: number; b: number }
  | { kind: 'piece'; i: number }
  | { kind: 'vkf'; sid: string; i: number }
  | { kind: 'bkf'; clip: number; i: number }
  | null

const VOICE_H = 120, BGM_H = 70, LABEL_W = 150
// 声の音量の線の縦の目盛り（dB）：上が +12、下が −36
const V_TOP = 12, V_BOT = -36
// BGM の線：上が +6、下が −42
const B_TOP = 6, B_BOT = -42

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el); setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** 押してから離すまでのドラッグ。離したときに end を呼ぶ */
function dragging(ev: React.PointerEvent, move: (m: PointerEvent) => void, end?: () => void) {
  ev.preventDefault(); ev.stopPropagation()
  const el = ev.currentTarget as HTMLElement
  el.setPointerCapture(ev.pointerId)
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); end?.() }
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up)
}

export function EditTimeline(p: Props) {
  const { project, view, total } = p
  const [ruler, w] = useWidth()
  const box = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<Sel>(null)
  const x = (t: number) => ((t - view.start) / view.span) * w
  const tAt = (clientX: number) => {
    const r = ruler.current!.getBoundingClientRect()
    return view.start + ((clientX - r.left) / r.width) * view.span
  }
  const ps = useMemo(() => pieces(project.edit), [project.edit])
  const setSegments = (segments: Project['edit']['segments'], group: string, opts?: ChangeOpts) =>
    p.onChange({ ...project, edit: { ...project.edit, segments } }, group, opts)
  const refDurAll = Math.min(...project.voices.map(v => p.refDur(v.source)).filter(d => d > 0), Infinity)
  const latest = useRef({ p, sel, project, ps })
  latest.current = { p, sel, project, ps }

  // ---- キー：Delete（選んだ範囲・区間・点を消す）、C（切れ目）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable]')) return
      const { p, sel, project } = latest.current
      if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const segs = splitAt(project.edit, p.player.position())
        if (segs !== project.edit.segments) p.onChange({ ...project, edit: { ...project.edit, segments: segs } }, `split-${Date.now()}`)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault(); e.stopImmediatePropagation()
        if (sel.kind === 'range') setSegmentsOf(cutOutRange(project.edit, sel.a, sel.b))
        else if (sel.kind === 'piece') setSegmentsOf(removePiece(project.edit, sel.i))
        else if (sel.kind === 'vkf') {
          p.onChange({ ...project, voices: project.voices.map(v => v.source === sel.sid ? { ...v, keyframes: (v.keyframes ?? []).filter((_, k) => k !== sel.i) } : v) }, `vkf-del-${Date.now()}`)
        } else if (sel.kind === 'bkf') {
          p.onChange({ ...project, bgm: project.bgm.map((c, k) => k === sel.clip ? removeKeyframe(c, sel.i) : c) }, `bkf-del-${Date.now()}`)
        }
        setSel(null)
      }
      if (e.key === 'Escape') setSel(null)
      function setSegmentsOf(segments: Project['edit']['segments']) {
        p.onChange({ ...project, edit: { ...project.edit, segments } }, `cut-${Date.now()}`)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  usePinch(box, ruler, view, p.setView, total)

  const ticks = rulerTicks(view.start, view.start + view.span, Math.max(2, Math.floor(w / 90)))
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1

  // 波形の上：クリックで移動、ドラッグで範囲を選ぶ
  const laneDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return
    const a = tAt(ev.clientX)
    let moved = false
    dragging(ev, m => {
      const b = tAt(m.clientX)
      if (Math.abs(m.clientX - ev.clientX) > 3) { moved = true; setSel({ kind: 'range', a: Math.min(a, b), b: Math.max(a, b) }) }
    }, () => {
      if (!moved) {
        p.player.seek(Math.max(0, a))
        const hit = latest.current.ps.find(q => a >= q.outStart && a < q.outEnd)
        setSel(hit && ps.length > 1 ? { kind: 'piece', i: hit.i } : null)
      }
    })
  }

  // 区間の端のドラッグ（離したら鳴らし直す）
  const edgeDown = (i: number, side: 'start' | 'end') => (ev: React.PointerEvent) => {
    const segs0 = project.edit.segments, t0 = tAt(ev.clientX)
    const v0 = segs0[i][side]
    let last = segs0
    dragging(ev, m => {
      last = setEdge(segs0, i, side, v0 + (tAt(m.clientX) - t0), refDurAll)
      setSegments(last, `edge-${i}-${side}`, { restart: false })
    }, () => setSegments(last, `edge-${i}-${side}`, { restart: true }))
  }

  // 声全体の位置（話し始め）を動かす
  const posDown = (ev: React.PointerEvent) => {
    const pos0 = project.edit.position, t0 = tAt(ev.clientX)
    let pos = pos0
    dragging(ev, m => {
      pos = +Math.max(0, pos0 + tAt(m.clientX) - t0).toFixed(3)
      p.onChange({ ...project, edit: { ...project.edit, position: pos } }, 'voice-pos', { restart: false })
    }, () => p.onChange({ ...project, edit: { ...project.edit, position: pos } }, 'voice-pos', { restart: true }))
  }

  const range = sel?.kind === 'range' ? sel : null
  // 名前の欄の幅：いちばん長い名前が切れずに入る広さ（全角1文字 ≒ 15px、丸い印・余白の分を足す）
  const nameChars = Math.max(0, ...project.voices.map(v => [...(v.name || v.source)].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 1 : 0.55), 0)))
  const labelW = Math.round(Math.min(260, Math.max(LABEL_W, 28 + 8 + 24 + 16 + nameChars * 15)))
  return (
    <div className="tl" ref={box} style={{ '--label-w': `${labelW}px` } as React.CSSProperties}>
      <Follow player={p.player} view={view} setView={p.setView} total={total} />
      <div className="trow">
        <div className="rubycell">{p.setShowRuby && (
          <label className="rubytoggle" title="波形の上に文字（フィラーは灰色）を出す">
            <input type="checkbox" checked={p.showRuby} onChange={e => p.setShowRuby!(e.target.checked)} />ルビ</label>
        )}</div>
        <div ref={ruler} className="ruler seekable" title="クリック・ドラッグで再生位置を移す（ダブルクリックで全体を表示）"
          onPointerDown={ev => {
            const at = (cx: number) => p.player.seek(Math.max(0, tAt(cx)))
            at(ev.clientX); dragging(ev, m => at(m.clientX))
          }}
          onDoubleClick={() => p.setView({ start: 0, span: Math.max(10, total) })}>
          {w > 0 && ticks.map(t => <div key={t} style={{ left: x(t) }}><span className="mono">{formatTime(t, step < 1 ? 1 : 0)}</span></div>)}
        </div>
      </div>

      {project.voices.map((v, vi) => (
        <div className="trow" key={v.source}>
          <TrackLabel name={v.name || v.source} color={p.colors[vi % p.colors.length]} sub={`${v.gain_db >= 0 ? '+' : ''}${v.gain_db.toFixed(1)} dB${v.mute ? ' ・ ミュート' : ''}`}
            onRename={n => p.onRename(v.source, n)} onOpen={() => p.onOpenFx(v.source)} />
          <div className="lane nle" style={{ height: VOICE_H }} onPointerDown={laneDown}>
            <VoiceWave peaks={p.peaks[v.source]} project={project} sid={v.source} ps={ps} view={view} width={w} color={p.colors[vi % p.colors.length]}
              top={p.showRuby ? 26 : 4} />
            {p.showRuby && <Ruby utterances={p.utterances} sid={v.source} ps={ps} view={view} width={w} />}
            <VolumeLine kfs={v.keyframes} ps={ps} view={view} width={w} height={VOICE_H}
              selected={sel?.kind === 'vkf' && sel.sid === v.source ? sel.i : null}
              onAdd={(r, db) => {
                const { kfs, index } = addPoint(v.keyframes, +r.toFixed(4), +db.toFixed(1))
                p.onChange({ ...project, voices: project.voices.map(x => x === v ? { ...x, keyframes: kfs } : x) }, `vkf-add-${Date.now()}`)
                setSel({ kind: 'vkf', sid: v.source, i: index })
              }}
              onDrag={(ev, i) => {
                setSel({ kind: 'vkf', sid: v.source, i })
                const k0 = v.keyframes ?? []
                const rect = (ev.currentTarget as HTMLElement).parentElement!.getBoundingClientRect()
                let last = k0
                dragging(ev, m => {
                  const ot = tAt(m.clientX)
                  const piece = latest.current.ps.find(q => ot >= q.outStart && ot < q.outEnd)
                  const r = piece ? piece.start + (ot - piece.outStart) : k0[i].t
                  last = movePoint(k0, i, r, dbOfY(m.clientY - rect.top, VOICE_H, V_TOP, V_BOT), -60, V_TOP)
                  p.onChange({ ...project, voices: project.voices.map(x => x === v ? { ...x, keyframes: last } : x) }, `vkf-${v.source}-${i}`, { restart: false })
                }, () => p.onChange({ ...project, voices: project.voices.map(x => x === v ? { ...x, keyframes: last } : x) }, `vkf-${v.source}-${i}`, { restart: true }))
              }} />
            {/* 区間（選ぶと枠、Delete で取り除く）と、つなぎ目の端 */}
            {w > 0 && ps.map(q => (
              <div key={q.i}>
                {sel?.kind === 'piece' && sel.i === q.i && <div className="piecesel" style={{ left: x(q.outStart), width: x(q.outEnd) - x(q.outStart) }} />}
                <div className="edgeh l" style={{ left: x(q.outStart) }} title="ドラッグで区間の頭を削る・戻す" onPointerDown={edgeDown(q.i, 'start')} />
                <div className="edgeh r" style={{ left: x(q.outEnd) }} title="ドラッグで区間の終わりを削る・戻す" onPointerDown={edgeDown(q.i, 'end')} />
                {q.i > 0 && <div className="cutline" style={{ left: x(q.outStart) }} />}
              </div>
            ))}
            {vi === 0 && w > 0 && (
              <div className="posgrip" style={{ left: x(project.edit.position) }} title="ドラッグで声全体の位置（話し始め）を動かす" onPointerDown={posDown}>⇔</div>
            )}
            {range && <div className="rangesel" style={{ left: x(range.a), width: x(range.b) - x(range.a) }} />}
            <PlayLine player={p.player} view={view} width={w} />
          </div>
        </div>
      ))}

      <div className="trow">
        <TrackLabel name="BGM" fixed color="#B79CFF" sub={project.bgm.map(c => c.source).join('・') || 'なし'}
          onOpen={() => p.onOpenFx(BGM_ID)} />
        <div className="lane nle bgm" style={{ height: BGM_H }} onPointerDown={ev => {
          if (ev.button !== 0) return
          p.player.seek(Math.max(0, tAt(ev.clientX))); setSel(null)
        }}>
          {project.bgm.map((c, ci) => (
            <BgmClipView key={ci} clip={c} ci={ci} project={project} peaks={p.peaks[c.source]} view={view} width={w} tAt={tAt}
              fileDur={p.player.duration(c.source)}
              selKf={sel?.kind === 'bkf' && sel.clip === ci ? sel.i : null}
              onSelKf={i => setSel(i == null ? null : { kind: 'bkf', clip: ci, i })}
              onChange={(nc, group, opts) => p.onChange({ ...project, bgm: project.bgm.map((x, k) => k === ci ? nc : x) }, group, opts)} />
          ))}
          <PlayLine player={p.player} view={view} width={w} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- トラック名

function TrackLabel({ name, color, sub, fixed, onRename, onOpen, extra }: {
  name: string; color: string; sub: string; fixed?: boolean; onRename?: (n: string) => void; onOpen: () => void; extra?: React.ReactNode
}) {
  const [text, setText] = useState(name)
  useEffect(() => setText(name), [name])
  return (
    <div className="tlabel clickable" onClick={onOpen} title="クリックでエフェクトを開く">
      <div className="tname">
        <span className="dot badge" aria-hidden="true" style={{ background: color }}>{fixed ? '♪' : (name.trim()[0] ?? '')}</span>
        {fixed ? <b>{name}</b> : (
          <input className="nameinput" value={text} aria-label="トラックの名前" title="名前を変える（台本の名前も変わる）"
            onClick={e => e.stopPropagation()}
            onChange={e => setText(e.target.value)}
            onBlur={() => { const t = text.trim(); if (t && t !== name) onRename?.(t); else setText(name) }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') { setText(name); (e.target as HTMLInputElement).blur() }
            }} />
        )}
        {extra}
      </div>
      <small>{sub}</small>
    </div>
  )
}

// ---------------------------------------------------------------- 声の波形（カットした部分は詰める）

const VoiceWave = memo(function VoiceWave({ peaks, project, sid, ps, view, width, color, top }: {
  peaks?: Peaks; project: Project; sid: string; ps: Piece[]; view: OutView; width: number; color: string; top: number
}) {
  const dark = useDark()
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv || !width) return
    const dpr = devicePixelRatio || 1, H = cv.clientHeight
    cv.width = Math.round(width * dpr); cv.height = Math.round(H * dpr)
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, width, H)
    if (!peaks) return
    const mid = top + (H - top - 4) / 2, amp = (H - top - 6) / 2, n = peaks.min.length
    for (const q of ps) {
      const xa = Math.max(0, Math.floor(((q.outStart - view.start) / view.span) * width))
      const xb = Math.min(width, Math.ceil(((q.outEnd - view.start) / view.span) * width))
      g.fillStyle = ink(0.04); g.fillRect(xa, 0, xb - xa, H)
      g.fillStyle = color
      for (let px = xa; px < xb; px++) {
        const ta = view.start + (px / width) * view.span, tb = ta + view.span / width
        const ra = q.start + (Math.max(ta, q.outStart) - q.outStart), rb = q.start + (Math.min(tb, q.outEnd) - q.outStart)
        let i0 = Math.floor(fileTime(project.sync, sid, ra) * peaks.rate), i1 = Math.ceil(fileTime(project.sync, sid, rb) * peaks.rate)
        i0 = Math.max(0, i0); i1 = Math.min(n, Math.max(i1, i0 + 1))
        if (i0 >= n) continue
        let lo = 127, hi = -127
        for (let i = i0; i < i1; i++) { if (peaks.min[i] < lo) lo = peaks.min[i]; if (peaks.max[i] > hi) hi = peaks.max[i] }
        if (hi < lo) continue
        const y0 = mid - (hi / 127) * amp, y1 = mid - (lo / 127) * amp
        g.fillRect(px, y0, 1, Math.max(1, y1 - y0))
      }
    }
  }, [peaks, project.sync, sid, ps, view, width, color, top, dark])
  return <canvas ref={ref} />
})

const Ruby = memo(function Ruby({ utterances, sid, ps, view, width }: { utterances: Utterance[]; sid: string; ps: Piece[]; view: OutView; width: number }) {
  if (view.span > 240 || !width) return <div className="ruby" />
  const x = (t: number) => ((t - view.start) / view.span) * width
  const t1 = view.start + view.span
  const items: React.ReactNode[] = []
  for (const q of ps) {
    if (q.outEnd < view.start || q.outStart > t1) continue
    utterances.forEach((u, ui) => {
      if (u.source !== sid || u.end <= q.start || u.start >= q.end) return
      const a = Math.max(u.start, q.start), b = Math.min(u.end, q.end)
      const words = u.words.filter(wd => wd.t1 > a && wd.t0 < b)
      if (!words.length) return
      const oa = q.outStart + (a - q.start), ob = q.outStart + (b - q.start)
      items.push(
        <div key={`${q.i}-${ui}`} style={{ left: x(oa), width: Math.max(4, x(ob) - x(oa)) }} title={u.text}>
          {words.map((wd, j) => wd.filler ? <span key={j} className="f">{wd.w}</span> : <span key={j}>{wd.w}</span>)}
        </div>)
    })
  }
  return <div className="ruby">{items}</div>
})

// ---------------------------------------------------------------- 声の音量の線

const yOfDb = (db: number, h: number, top: number, bot: number) => 4 + ((top - Math.max(bot, Math.min(top, db))) / (top - bot)) * (h - 8)
const dbOfY = (y: number, h: number, top: number, bot: number) => top - ((y - 4) / (h - 8)) * (top - bot)

function VolumeLine({ kfs, ps, view, width, height, selected, onAdd, onDrag }: {
  kfs?: Keyframe[]; ps: Piece[]; view: OutView; width: number; height: number; selected: number | null
  onAdd: (refT: number, db: number) => void; onDrag: (ev: React.PointerEvent, i: number) => void
}) {
  if (!width) return null
  const x = (t: number) => ((t - view.start) / view.span) * width
  // 線（区間ごと）
  const segs = ps.filter(q => q.outEnd > view.start && q.outStart < view.start + view.span).map(q => {
    const xa = Math.max(0, x(q.outStart)), xb = Math.min(width, x(q.outEnd))
    const pts: string[] = []
    const n = Math.max(2, Math.ceil((xb - xa) / 4))
    for (let k = 0; k <= n; k++) {
      const px = xa + ((xb - xa) * k) / n
      const ot = view.start + (px / width) * view.span
      pts.push(`${px.toFixed(1)},${yOfDb(curveDbAt(kfs, q.start + (ot - q.outStart)), height, V_TOP, V_BOT).toFixed(1)}`)
    }
    return { key: q.i, pts: pts.join(' '), q }
  })
  const outOf = (r: number) => { const q = ps.find(p => r >= p.start && r < p.end); return q ? q.outStart + (r - q.start) : null }
  return (
    <>
      <svg className="volsvg" width={width} height={height} aria-hidden="true">
        {segs.map(s => <polyline key={s.key} points={s.pts} />)}
      </svg>
      {segs.map(s => (
        <div key={s.key} className="volhit" style={{ left: Math.max(0, x(s.q.outStart)), width: Math.min(width, x(s.q.outEnd)) - Math.max(0, x(s.q.outStart)) }}
          title="クリックで音量の点を打つ"
          onPointerDown={ev => {
            const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
            const ot = view.start + ((ev.clientX - (r.left - Math.max(0, x(s.q.outStart)))) / width) * view.span
            const ref = s.q.start + (ot - s.q.outStart)
            const lineY = yOfDb(curveDbAt(kfs, ref), height, V_TOP, V_BOT)
            const y = ev.clientY - (r.top)
            if (Math.abs(y - lineY) > 7) return // 線の近くだけ（それ以外は範囲選び）
            ev.stopPropagation(); ev.preventDefault()
            onAdd(ref, curveDbAt(kfs, ref))
          }} />
      ))}
      {(kfs ?? []).map((k, i) => {
        const o = outOf(k.t)
        if (o == null || o < view.start || o > view.start + view.span) return null
        return <button key={i} className={`volpt${selected === i ? ' sel' : ''}`} style={{ left: x(o), top: yOfDb(k.db, height, V_TOP, V_BOT) }}
          aria-label={`音量の点 ${k.db.toFixed(1)} dB`} title={`${k.db > 0 ? '+' : ''}${k.db.toFixed(1)} dB（Delete で消す）`}
          onPointerDown={ev => onDrag(ev, i)} />
      })}
    </>
  )
}

// ---------------------------------------------------------------- BGM

function BgmClipView({ clip, ci, project, peaks, view, width, tAt, fileDur, selKf, onSelKf, onChange }: {
  clip: BgmClip; ci: number; project: Project; peaks?: Peaks; view: OutView; width: number; tAt: (cx: number) => number; fileDur?: number
  selKf: number | null; onSelKf: (i: number | null) => void; onChange: (c: BgmClip, group: string, opts?: ChangeOpts) => void
}) {
  useDark() // 外観が変わったら描き直す（下の effect は毎回走る）
  const cv = useRef<HTMLCanvasElement>(null)
  const s = clipStart(project, clip), e = clipEnd(project, clip)
  const x = (t: number) => ((t - view.start) / view.span) * width
  const xa = x(s), xb = x(e)
  const H = BGM_H
  const yOf = (db: number) => yOfDb(db, H, B_TOP, B_BOT)
  useEffect(() => {
    const c = cv.current
    if (!c || !width) return
    const W = Math.max(1, Math.round(xb - xa)), dpr = devicePixelRatio || 1
    c.width = Math.max(1, Math.min(8000, W)) * dpr; c.height = H * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H)
    const x0 = Math.max(0, -xa), x1 = Math.min(W, width - xa)
    if (peaks) {
      const n = peaks.min.length, mid = H / 2
      for (let px = Math.floor(x0); px < x1; px++) {
        const ct = (px / (xb - xa)) * clip.duration, ct1 = ct + clip.duration / (xb - xa)
        let i0 = Math.floor((clip.offset_in + ct) * peaks.rate), i1 = Math.ceil((clip.offset_in + ct1) * peaks.rate)
        i0 = Math.max(0, i0); i1 = Math.min(n, Math.max(i1, i0 + 1))
        let hi = 0
        for (let i = i0; i < i1; i++) hi = Math.max(hi, peaks.max[i], -peaks.min[i])
        const gain = Math.pow(10, clipGainDb(clip, ct) / 20)
        const a = Math.min(1, (hi / 127) * gain) * (H / 2 - 4)
        g.fillStyle = 'rgba(183,156,255,0.55)'; g.fillRect(px, mid - a, 1, Math.max(1, a * 2))
      }
    }
    g.strokeStyle = isDark() ? '#E2D6FF' : '#6B4FC8'; g.lineWidth = 1.5; g.beginPath()
    for (let px = Math.floor(x0); px <= x1; px += 2) {
      const ct = (px / (xb - xa)) * clip.duration
      const y = yOf(clipGainDb(clip, Math.min(clip.duration, Math.max(0, ct))))
      if (px === Math.floor(x0)) g.moveTo(px, y); else g.lineTo(px, y)
    }
    g.stroke()
  }) // eslint-disable-line react-hooks/exhaustive-deps
  if (!width || xb < 0 || xa > width) return null
  const drag = (make: (dt: number, m: PointerEvent) => BgmClip, group: string) => (ev: React.PointerEvent) => {
    const t0 = tAt(ev.clientX)
    let last: BgmClip | null = null
    dragging(ev, m => { last = make(tAt(m.clientX) - t0, m); onChange(last, group, { restart: false }) },
      () => { if (last) onChange(last, group, { restart: true }) })
  }
  const laneRect = () => cv.current!.getBoundingClientRect()
  return (
    <div className="bgmclip" style={{ left: xa, width: xb - xa }}
      title={`${clip.source}：ドラッグで位置を動かす`}
      onPointerDown={ev => {
        if (ev.button !== 0) return
        // 線の近くをクリック → 音量の点を打つ。それ以外はドラッグで移動
        const r = laneRect(), ct = ((ev.clientX - r.left) / r.width) * clip.duration
        if (Math.abs(ev.clientY - r.top - yOf(clipGainDb(clip, ct))) <= 7) {
          ev.stopPropagation(); ev.preventDefault()
          const kdb = clipGainDb(clip, ct) - clip.gain_db
          const nc = addKeyframe(clip, ct, +kdb.toFixed(1))
          onChange(nc, `bkf-add-${Date.now()}`)
          onSelKf(nc.keyframes.findIndex(k => Math.abs(k.t - ct) < 1e-6))
          return
        }
        onSelKf(null)
        const at0 = clip.at
        drag(dt => ({ ...clip, at: +(at0 + dt).toFixed(3) }), `bgm-move-${ci}`)(ev)
      }}>
      <canvas ref={cv} style={{ width: '100%', height: '100%' }} />
      <span className="bgmname">{clip.source}</span>
      <div className="edgeh l bgm" title="ドラッグで頭を削る・戻す（元の曲は残る）"
        onPointerDown={drag(dt => moveStart(project, clip, s + dt, { keepEnd: true, fileDuration: fileDur }), `bgm-start-${ci}`)} />
      <div className="edgeh r bgm" title="ドラッグで切る位置を変える（元の曲は残る）"
        onPointerDown={drag(dt => moveEnd(project, clip, e + dt, fileDur), `bgm-end-${ci}`)} />
      <div className="fadeh" style={{ left: ((clip.fade_in / clip.duration) * (xb - xa)) }} title={`フェードイン ${clip.fade_in.toFixed(1)} 秒`}
        onPointerDown={drag(dt => setFade(clip, 'in', clip.fade_in + dt), `bgm-fin-${ci}`)} />
      <div className="fadeh" style={{ left: ((1 - clip.fade_out / clip.duration) * (xb - xa)) }} title={`フェードアウト ${clip.fade_out.toFixed(1)} 秒`}
        onPointerDown={drag(dt => setFade(clip, 'out', clip.fade_out - dt), `bgm-fout-${ci}`)} />
      {clip.keyframes.map((k, i) => (
        <button key={i} className={`volpt bgm${selKf === i ? ' sel' : ''}`}
          style={{ left: (k.t / clip.duration) * (xb - xa), top: yOf(clip.gain_db + k.db) }}
          aria-label={`BGM の音量の点 ${k.db.toFixed(1)} dB`} title={`${(clip.gain_db + k.db).toFixed(1)} dB（Delete で消す）`}
          onPointerDown={ev => {
            onSelKf(i)
            const rect = laneRect()
            let last = clip
            dragging(ev, m => {
              const ct = ((m.clientX - rect.left) / rect.width) * clip.duration
              last = moveKeyframe(clip, i, ct, +(dbOfY(m.clientY - rect.top, H, B_TOP, B_BOT) - clip.gain_db).toFixed(1)).clip
              onChange(last, `bkf-${ci}-${i}`, { restart: false })
            }, () => onChange(last, `bkf-${ci}-${i}`, { restart: true }))
          }} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- 再生位置・追いかけ・ピンチ

function PlayLine({ player, view, width }: { player: Player; view: OutView; width: number }) {
  const left = usePlayhead(player, t => Math.round(((t - view.start) / view.span) * width))
  if (left < 0 || left > width) return null
  return <div className="playline" style={{ left }} />
}

function Follow({ player, view, setView, total }: { player: Player; view: OutView; setView: (v: OutView) => void; total: number }) {
  const t = usePlayhead(player, (t, playing) => (playing ? Math.floor(t * 4) / 4 : null))
  useEffect(() => {
    if (t == null) return
    if (t < view.start || t > view.start + view.span * 0.95)
      setView({ ...view, start: clamp(t - view.span * 0.05, 0, Math.max(0, total - view.span * 0.5)) })
  }, [t]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

const MIN_SPAN = 3

/** ピンチで拡大・縮小、2本指の左右で移動 */
function usePinch(box: React.RefObject<HTMLDivElement | null>, ruler: React.RefObject<HTMLDivElement | null>,
  view: OutView, setView: (v: OutView) => void, total: number) {
  const latest = useRef({ view, setView, total })
  latest.current = { view, setView, total }
  const pending = useRef<OutView | null>(null)
  const seen = useRef(view)
  if (seen.current !== view) { seen.current = view; pending.current = null }
  useEffect(() => {
    const el = box.current
    if (!el) return
    const cur = () => pending.current ?? latest.current.view
    const apply = (v: OutView) => {
      const T = Math.max(10, latest.current.total)
      const span = clamp(v.span, MIN_SPAN, T * 1.1)
      const nv = { span, start: clamp(v.start, 0, Math.max(0, T - span * 0.5)) }
      pending.current = nv; latest.current.setView(nv)
    }
    const zoomAt = (span: number, cx: number, base = cur()) => {
      const r = ruler.current?.getBoundingClientRect()
      const f = r && r.width ? clamp((cx - r.left) / r.width, 0, 1) : 0.5
      const t = base.start + f * base.span
      apply({ start: t - f * span, span })
    }
    const onWheel = (e: WheelEvent) => {
      const v = cur()
      if (e.ctrlKey) { e.preventDefault(); zoomAt(v.span * Math.exp(e.deltaY * 0.01), e.clientX); return }
      const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (!horiz) return
      e.preventDefault()
      apply({ ...v, start: v.start + (horiz / (ruler.current?.clientWidth || 1)) * v.span })
    }
    let g0: OutView | null = null
    const gs = (e: Event) => { e.preventDefault(); g0 = cur() }
    const gc = (e: Event) => { e.preventDefault(); const g = e as Event & { scale: number; clientX: number }; if (g0 && g.scale > 0) zoomAt(g0.span / g.scale, g.clientX, g0) }
    const ge = (e: Event) => { e.preventDefault(); g0 = null }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', gs); el.addEventListener('gesturechange', gc); el.addEventListener('gestureend', ge)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', gs); el.removeEventListener('gesturechange', gc); el.removeEventListener('gestureend', ge)
    }
  }, [box, ruler])
}

export { LABEL_W }
