// 全体バー（出力時刻）と、トラックごとの波形・ルビ（基準時刻）。
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { refToOutOrNext } from './editops'
import { scrubHandler } from './layout'
import type { Player } from './player'
import { usePlayhead } from './playhead'
import { useDark } from './theme'
import { bgmGainAt, bgmStart, fileTime, formatTime, layout, outToRef, rulerTicks } from './timeline'
import type { Peaks, Project, Segment, Utterance } from './types'

export interface View { start: number; span: number } // 基準時刻

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** カットされている区間（基準時刻）。0〜total のうち、残す区間に入っていないところ */
export function cutGaps(segs: Segment[], total: number): [number, number][] {
  const s = [...segs].sort((a, b) => a.start - b.start)
  const out: [number, number][] = []
  let t = 0
  for (const x of s) { if (x.start > t) out.push([t, x.start]); t = Math.max(t, x.end) }
  if (t < total) out.push([t, total])
  return out
}

// ---------------------------------------------------------------- 全体バー

export function Overview({ project, player, view, total }: { project: Project; player: Player; view?: View; total: number }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const len = Math.max(total, 1)
  const pct = (t: number) => `${(t / len) * 100}%`
  const lay = layout(project.edit)
  const playOut = usePlayhead(player, t => Math.round((t / len) * Math.max(w, 1) * 2) / 2)
  // view は完成版の時刻（編集画面の表示範囲）
  const v0 = view ? view.start : 0
  const v1 = view ? view.start + view.span : 0
  return (
    <div className="overview">
      <div ref={ref} className="ov" role="slider" aria-label="全体の再生位置" aria-valuemin={0} aria-valuemax={len} aria-valuenow={player.position()}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); player.seek(((e.clientX - r.left) / r.width) * len) }}>
        {project.bgm.map((c, i) => {
          const s = bgmStart(project, c)
          return <div key={i} style={{ left: pct(s), width: pct(c.duration), top: 0, bottom: 0, background: 'var(--bgm-bg)' }}>
            <span style={{ fontSize: 11, color: 'var(--accent-text)', padding: '0 6px' }}>{c.source}</span></div>
        })}
        {lay.map((l, i) => <div key={i} style={{ left: pct(l.outStart), width: pct(l.end - l.start), top: 15, height: 6, borderRadius: 3, background: 'rgba(110,139,239,0.5)' }} />)}
        {lay.slice(1).map((l, i) => <div key={i} style={{ left: pct(l.outStart), top: 0, bottom: 0, width: 2, background: 'var(--cut-line)' }} />)}
        {view && <div style={{ left: pct(v0), width: pct(Math.max(v1 - v0, len / 400)), top: 2, bottom: 2, border: '2px solid var(--text)', borderRadius: 4 }} />}
        <div style={{ left: playOut, top: 0, bottom: 0, width: 2, background: 'var(--text)' }} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- トラック

interface TracksProps {
  project: Project; utterances: Utterance[]; peaks: Record<string, Peaks>; player: Player
  view: View; setView: (v: View) => void; refTotal: number; showRuby: boolean; colors: string[]
}

const MIN_SPAN = 3 // 一番拡大したときに見える秒数

/**
 * ピンチ（トラックパッドの2本指を広げる・つまむ）で拡大・縮小、2本指の横スクロールで左右に移動。
 * Chrome などはピンチを「ctrl 付きのホイール」として送り、Safari は gesture イベントで送る。
 * どちらもページ全体の拡大にならないよう止める（passive: false が必要なので React の onWheel は使わない）。
 */
function usePinchZoom(box: React.RefObject<HTMLDivElement | null>, ruler: React.RefObject<HTMLDivElement | null>, p: TracksProps) {
  const latest = useRef(p)
  latest.current = p
  // 画面の書き直しを待たずに次の操作が来ても積み重なるよう、最後に決めた表示範囲を覚えておく
  const pending = useRef<View | null>(null)
  const seen = useRef(p.view)
  if (seen.current !== p.view) { seen.current = p.view; pending.current = null } // 描き直されたら画面の値が最新
  useEffect(() => {
    const el = box.current
    if (!el) return
    const current = () => pending.current ?? latest.current.view
    const apply = (v: View) => { pending.current = v; latest.current.setView(v) }
    const zoomAt = (span: number, clientX: number, base = current()) => {
      const { refTotal } = latest.current
      const r = ruler.current?.getBoundingClientRect()
      const frac = r && r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0.5
      const t = base.start + frac * base.span // 指の下の時刻を動かさない
      span = Math.min(Math.max(MIN_SPAN, span), Math.max(10, refTotal))
      apply({ start: clampStart(t - frac * span, span, refTotal), span })
    }
    const onWheel = (e: WheelEvent) => {
      const view = current(), { refTotal } = latest.current
      if (e.ctrlKey) { e.preventDefault(); zoomAt(view.span * Math.exp(e.deltaY * 0.01), e.clientX); return }
      const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (!horiz) return
      e.preventDefault() // 横スワイプで「前のページに戻る」にならないように
      const w = ruler.current?.clientWidth || 1
      apply({ ...view, start: clampStart(view.start + (horiz / w) * view.span, view.span, refTotal) })
    }
    // Safari のピンチ
    let startView: View | null = null
    const onGestureStart = (e: Event) => { e.preventDefault(); startView = current() }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number }
      if (startView && g.scale > 0) zoomAt(startView.span / g.scale, g.clientX, startView)
    }
    const onGestureEnd = (e: Event) => { e.preventDefault(); startView = null }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    el.addEventListener('gestureend', onGestureEnd)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
      el.removeEventListener('gestureend', onGestureEnd)
    }
  }, [box, ruler])
}

export function Tracks(p: TracksProps) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const boxRef = useRef<HTMLDivElement>(null)
  const { view, project } = p
  const x = (t: number) => ((t - view.start) / view.span) * w
  const ticks = rulerTicks(view.start, view.start + view.span, Math.max(2, Math.floor(w / 90)))
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1
  const gaps = useMemo(() => cutGaps(project.edit.segments, p.refTotal), [project.edit.segments, p.refTotal])
  const seekAt = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const t = view.start + ((e.clientX - r.left) / r.width) * view.span
    p.player.seek(refToOutOrNext(project.edit, t))
  }
  usePinchZoom(boxRef, ref, p)
  // 波形の高さは欄の広さに合わせる（ミキサーの境目をドラッグすると伸び縮みする）
  const [boxH, setBoxH] = useState(0)
  useLayoutEffect(() => {
    const el = boxRef.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(() => setBoxH(el.clientHeight))
    ro.observe(el); setBoxH(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  const laneH = Math.max(70, Math.floor((boxH - 22 - 52 - 40 - 8 * (project.voices.length + 1)) / Math.max(1, project.voices.length)))
  return (
    <div className="tracks" ref={boxRef}>
      <Follow {...p} />
      <div className="trow">
        <div />
        <div ref={ref} className="ruler seekable" title="クリック・ドラッグで再生位置を移す"
          onPointerDown={scrubHandler(f => p.player.seek(refToOutOrNext(project.edit, view.start + f * view.span)))}>
          {w > 0 && ticks.map(t => <div key={t} style={{ left: x(t) }}><span className="mono">{formatTime(t, step < 1 ? 1 : 0)}</span></div>)}
          {w > 0 && gaps.filter(([a, b]) => b > view.start && a < view.start + view.span).map(([a, b]) => (
            <div key={a} style={{ left: Math.max(0, x(a)), width: Math.min(w, x(b)) - Math.max(0, x(a)), top: 1, bottom: 'auto', height: 16, background: 'var(--bad-bg)', borderRadius: 4, overflow: 'hidden', textAlign: 'center', color: 'var(--bad)', whiteSpace: 'nowrap' }}>
              カット {(b - a).toFixed(1)}秒</div>
          ))}
        </div>
      </div>
      {project.voices.map((v, i) => (
        <div className="trow" key={v.source}>
          <div className="tlabel">
            <b><span className="dot" style={{ width: 10, height: 10, borderRadius: '50%', background: p.colors[i] }} />{v.name || v.source}</b>
            <small>{v.denoise ? 'ノイズ除去 ・ ' : ''}{v.gain_db >= 0 ? '+' : ''}{v.gain_db.toFixed(1)} dB{v.mute ? ' ・ ミュート' : ''}</small>
          </div>
          <div className="lane" style={{ height: laneH }} onClick={seekAt}>
            <Wave key={laneH} peaks={p.peaks[v.source]} project={project} sid={v.source} view={view} width={w} color={p.colors[i]} gaps={gaps} top={p.showRuby ? 30 : 4} />
            {p.showRuby && <Ruby utterances={p.utterances} sid={v.source} view={view} width={w} />}
            <PlayLine player={p.player} project={project} view={view} width={w} />
          </div>
        </div>
      ))}
      <div className="trow">
        <div className="tlabel"><b><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--bgm)' }} />BGM</b>
          <small>{project.bgm.length ? project.bgm.map(c => c.source).join('・') : 'なし'}</small></div>
        <div className="lane" style={{ height: 52 }} onClick={seekAt}>
          <BgmLane project={project} view={view} width={w} />
          <PlayLine player={p.player} project={project} view={view} width={w} />
        </div>
      </div>
    </div>
  )
}

export function clampStart(start: number, span: number, total: number) {
  return Math.max(0, Math.min(start, Math.max(0, total - span)))
}

/** 再生中、再生位置が見えている範囲から出たら表示を送る */
function Follow({ player, project, view, setView, refTotal }: TracksProps) {
  const ref = usePlayhead(player, (t, playing) => (playing ? outToRef(project.edit, t) : null))
  useEffect(() => {
    if (ref == null) return
    if (ref < view.start || ref > view.start + view.span * 0.95)
      setView({ ...view, start: clampStart(ref - view.span * 0.05, view.span, refTotal) })
  }, [ref, view, setView, refTotal])
  return null
}

function PlayLine({ player, project, view, width }: { player: Player; project: Project; view: View; width: number }) {
  const left = usePlayhead(player, t => {
    const r = outToRef(project.edit, t)
    return r == null ? null : Math.round(((r - view.start) / view.span) * width)
  })
  if (left == null || left < 0 || left > width) return null
  return <div className="playline" style={{ left }} />
}

const Wave = memo(function Wave({ peaks, project, sid, view, width, color, gaps, top }: {
  peaks?: Peaks; project: Project; sid: string; view: View; width: number; color: string; gaps: [number, number][]; top: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv || !width) return
    const dpr = window.devicePixelRatio || 1
    const H = cv.clientHeight
    cv.width = Math.round(width * dpr); cv.height = Math.round(H * dpr)
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, H)
    const x = (t: number) => ((t - view.start) / view.span) * width
    // カット区間
    g.fillStyle = 'rgba(255,107,107,0.16)'
    for (const [a, b] of gaps) {
      const xa = Math.max(0, x(a)), xb = Math.min(width, x(b))
      if (xb > xa) {
        g.fillRect(xa, 0, xb - xa, H)
        g.fillStyle = '#FF8A8A'; g.fillRect(xa, 0, 1, H); g.fillRect(xb - 1, 0, 1, H); g.fillStyle = 'rgba(255,107,107,0.16)'
      }
    }
    if (!peaks) return
    const mid = top + (H - top - 4) / 2, amp = (H - top - 6) / 2
    g.fillStyle = color
    const n = peaks.min.length
    for (let px = 0; px < width; px++) {
      const ta = view.start + (px / width) * view.span, tb = view.start + ((px + 1) / width) * view.span
      let i0 = Math.floor(fileTime(project.sync, sid, ta) * peaks.rate)
      let i1 = Math.ceil(fileTime(project.sync, sid, tb) * peaks.rate)
      i0 = Math.max(0, i0); i1 = Math.min(n, Math.max(i1, i0 + 1))
      if (i0 >= n) break
      let lo = 127, hi = -127
      for (let i = i0; i < i1; i++) { if (peaks.min[i] < lo) lo = peaks.min[i]; if (peaks.max[i] > hi) hi = peaks.max[i] }
      if (hi < lo) continue
      const inCut = gaps.some(([a, b]) => ta >= a && ta < b)
      g.globalAlpha = inCut ? 0.3 : 1
      const y0 = mid - (hi / 127) * amp, y1 = mid - (lo / 127) * amp
      g.fillRect(px, y0, 1, Math.max(1, y1 - y0))
    }
    g.globalAlpha = 1
  }, [peaks, project.sync, sid, view, width, color, gaps, top])
  return <canvas ref={ref} />
})

const Ruby = memo(function Ruby({ utterances, sid, view, width }: { utterances: Utterance[]; sid: string; view: View; width: number }) {
  if (view.span > 240 || !width) return <div className="ruby"><div className="hint" style={{ left: 8 }}>拡大するとルビが出ます</div></div>
  const x = (t: number) => ((t - view.start) / view.span) * width
  const t1 = view.start + view.span
  return (
    <div className="ruby">
      {utterances.filter(u => u.source === sid && u.end > view.start && u.start < t1).map((u, i) => (
        <div key={i} style={{ left: x(u.start), width: Math.max(4, x(u.end) - x(u.start)) }} title={u.text}>
          {u.words.map((w, j) => w.filler ? <span key={j} className="f">{w.w}</span> : <span key={j}>{w.w}</span>)}
        </div>
      ))}
    </div>
  )
})

/** BGM：出力時刻のクリップを基準時刻の物差しに写し、音量カーブを描く */
const BgmLane = memo(function BgmLane({ project, view, width }: { project: Project; view: View; width: number }) {
  const dark = useDark()
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv || !width) return
    const dpr = window.devicePixelRatio || 1, H = cv.clientHeight
    cv.width = Math.round(width * dpr); cv.height = Math.round(H * dpr)
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, H)
    const lay = layout(project.edit)
    const y = (gain: number) => { const db = 20 * Math.log10(Math.max(gain, 1e-4)); return 4 + (Math.min(6, -db) / 46 + 0.13) * (H - 8) }
    for (const c of project.bgm) {
      const s = bgmStart(project, c), e = s + c.duration
      for (const l of lay) {
        const a = Math.max(s, l.outStart), b = Math.min(e, l.outStart + (l.end - l.start))
        if (b <= a) continue
        const ra = l.start + (a - l.outStart), rb = l.start + (b - l.outStart)
        const xa = ((ra - view.start) / view.span) * width, xb = ((rb - view.start) / view.span) * width
        if (xb < 0 || xa > width) continue
        g.fillStyle = dark ? '#3A2F5C' : '#DCD3FA'; g.fillRect(xa, 0, xb - xa, H)
        g.strokeStyle = dark ? '#B79CFF' : '#7A5FD0'; g.lineWidth = 1.5; g.beginPath()
        for (let px = Math.max(0, Math.floor(xa)); px <= Math.min(width, xb); px++) {
          const r = view.start + (px / width) * view.span
          const gy = y(bgmGainAt(c, l.outStart + (r - l.start) - s))
          if (px === Math.max(0, Math.floor(xa))) g.moveTo(px, gy); else g.lineTo(px, gy)
        }
        g.stroke()
        g.fillStyle = dark ? '#D9CCFF' : '#4B3A99'; g.font = '11px sans-serif'; g.fillText(c.source, Math.max(xa, 0) + 6, H - 6)
      }
    }
  }, [project, view, width, dark])
  return <canvas ref={ref} />
})
