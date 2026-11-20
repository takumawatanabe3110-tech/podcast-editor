// ② BGM の編集：OP／ED を選び、音量カーブの点・始まり・切る位置・フェードをドラッグや数値で変える。
// 時刻の軸は出力時刻（完成版の時刻）。BGM は出力時刻で置くため。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  addKeyframe, clipEnd, clipGainDb, clipStart, findClip, formatDb, moveEnd, moveKeyframe, moveStart,
  removeKeyframe, setAnchor, setFade,
} from './bgmops'
import { clamp, scrubHandler, Splitter, type Layout } from './layout'
import type { Player } from './player'
import { usePlayhead } from './playhead'
import { fileTime, formatTime, isCut, layout, outputEnd, outToRef, rulerTicks } from './timeline'
import type { BgmAnchor, BgmClip, Peaks, Project, Utterance } from './types'

export type ChangeOpts = { restart?: boolean }

interface Props {
  project: Project; player: Player; peaks: Record<string, Peaks>; colors: string[]; utterances: Utterance[]
  onChange: (p: Project, group?: string, opts?: ChangeOpts) => void
  layout: Layout; setLayout: (patch: Partial<Layout>) => void
}

const DB_TOP = 6, DB_BOTTOM = -42 // 音量カーブの縦軸（dB）
const ANCHORS: { value: BgmAnchor; label: string }[] = [
  { value: 'voice_start', label: '話し始めから（自動で追従）' },
  { value: 'voice_end', label: '話の終わりから（自動で追従）' },
  { value: 'output_start', label: '時刻を固定（完成版の頭から）' },
]
const CURVES = [{ v: 1, label: '直線' }, { v: 2, label: 'ゆっくり始まる（カーブ 2）' }, { v: 3, label: 'もっとゆっくり（カーブ 3）' }]

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

export function BgmView({ project, player, peaks, colors, utterances, onChange, layout, setLayout }: Props) {
  const dragBase = useRef(0)
  const op = findClip(project, 'op'), ed = findClip(project, 'ed')
  const [which, setWhich] = useState<'op' | 'ed'>(op >= 0 ? 'op' : 'ed')
  const ci = which === 'op' ? op : ed
  const clip = ci >= 0 ? project.bgm[ci] : null
  const [selKf, setSelKf] = useState<number | null>(null)
  const voiceStart = project.edit.position, voiceEnd = outputEnd(project.edit)

  // 表示する範囲（出力時刻）。OP は頭〜話し始めの少し後、ED は曲全体
  const defaultWin = (c: BgmClip | null) => {
    if (!c) return { start: 0, span: 30 }
    const s = clipStart(project, c), e = clipEnd(project, c)
    if (which === 'op') return { start: Math.max(0, s - 1), span: Math.max(12, voiceStart - s + 14) }
    return { start: s - (e - s) * 0.04, span: (e - s) * 1.08 }
  }
  const [win, setWin] = useState(() => defaultWin(clip))
  useEffect(() => { setWin(defaultWin(clip)); setSelKf(null) }, [which]) // eslint-disable-line react-hooks/exhaustive-deps

  const update = (c: BgmClip, group: string, opts?: ChangeOpts) =>
    onChange({ ...project, bgm: project.bgm.map((x, i) => (i === ci ? c : x)) }, group, opts)

  // 選んだ点を Delete で消す
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selKf == null || !clip || (e.target as HTMLElement).closest('input, textarea, select')) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); e.stopImmediatePropagation()
        update(removeKeyframe(clip, selKf), `kf-del-${Date.now()}`); setSelKf(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!clip) return <div className="center">この回には BGM がありません</div>
  const s = clipStart(project, clip), e = clipEnd(project, clip)
  const fileDur = player.duration(clip.source)
  const bgmSources = Object.entries(project.sources).filter(([, v]) => v.kind === 'bgm').map(([k]) => k)
  // カットした発言（収録後の雑談など）は除く
  const kept = utterances.filter(u => u.script.trim() && !isCut(project.edit.segments, u.start, u.end))
  const lastWords = which === 'op' ? kept[0]?.script : kept[kept.length - 1]?.script

  return (
    <div className="bgmview" style={{ gridTemplateColumns: `minmax(0, 1fr) 6px ${layout.bgmSideW}px` }}>
      <div className="bgmmain">
        <div className="bgmhead">
          <div className="tabs" role="group" aria-label="BGM の切り替え">
            {op >= 0 && <button aria-pressed={which === 'op'} title={project.bgm[op].source} onClick={() => setWhich('op')}>OP</button>}
            {ed >= 0 && <button aria-pressed={which === 'ed'} title={project.bgm[ed].source} onClick={() => setWhich('ed')}>ED</button>}
          </div>
          {which === 'op'
            ? <button className="btn" title="話し始めの前後 12 秒を試聴" onClick={() => player.playRange(Math.max(0, voiceStart - 6), voiceStart + 6)}>▶ 話し始め</button>
            : <button className="btn" title="話の終わりの前後を試聴" onClick={() => player.playRange(Math.max(s, voiceEnd - 10), voiceEnd + 6)}>▶ 話の終わり</button>}
          <button className="btn" title="曲の終わりの 12 秒を試聴" onClick={() => player.playRange(Math.max(0, e - 12), e + 1)}>▶ 曲の終わり</button>
        </div>
        <Lanes project={project} clip={clip} player={player} peaks={peaks} colors={colors} win={win} setWin={setWin}
          selKf={selKf} setSelKf={setSelKf} fileDur={fileDur} update={update} lastWords={lastWords} which={which}
          bgmH={layout.bgmLaneH} onResetView={() => setWin(defaultWin(clip))}
          onLaneStart={() => { dragBase.current = layout.bgmLaneH }}
          onLaneDrag={d => setLayout({ bgmLaneH: clamp(dragBase.current + d, 100, 600) })} />
      </div>
      <Splitter dir="col" label="設定欄の幅" onStart={() => { dragBase.current = layout.bgmSideW }}
        onDrag={d => setLayout({ bgmSideW: clamp(dragBase.current - d, 260, 640) })} />

      <aside className="bgmside">
        <details open>
          <summary>位置</summary>
          <label>素材
            <select value={clip.source} onChange={ev => update({ ...clip, source: ev.target.value }, `src-${Date.now()}`)}>
              {bgmSources.map(k => <option key={k} value={k}>{k}（{project.sources[k].path.split('/').pop()}）</option>)}
            </select>
          </label>
          <label title={`完成版の ${formatTime(s)}〜${formatTime(e)}`}>置き方
            <select value={clip.anchor} onChange={ev => update(setAnchor(project, clip, ev.target.value as BgmAnchor), `anchor-${Date.now()}`)}>
              {ANCHORS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
          <div className="pair">
            <Num label="位置（秒）" value={clip.at} step={0.1} onChange={v => update({ ...clip, at: v }, 'at')}
              title={`置き方の基準からの秒（マイナスは前）。完成版の ${formatTime(s)} から`} />
            <Num label="音量（dB）" value={clip.gain_db} step={0.5} onChange={v => update({ ...clip, gain_db: v }, 'gain')} />
          </div>
        </details>
        <details open>
          <summary>長さ・フェード</summary>
          <div className="pair">
            <Num label="曲のどこから（秒）" value={clip.offset_in} step={0.1} min={0}
              title={`曲の ${formatTime(clip.offset_in)}〜${formatTime(clip.offset_in + clip.duration)} を使う${fileDur ? `（曲の長さ ${formatTime(fileDur)}）` : ''}`}
              onChange={v => update({ ...clip, offset_in: Math.max(0, Math.min(v, (fileDur ?? Infinity) - 0.1)) }, 'offset')} />
            <Num label="長さ（秒）" value={clip.duration} step={0.1} min={0.1}
              onChange={v => update(moveEnd(project, clip, s + v, fileDur), 'dur')} />
          </div>
          <div className="pair">
            <Num label="フェードイン（秒）" value={clip.fade_in} step={0.1} min={0} onChange={v => update(setFade(clip, 'in', v), 'fin')} />
            <Num label="フェードアウト（秒）" value={clip.fade_out} step={0.1} min={0} onChange={v => update(setFade(clip, 'out', v), 'fout')} />
          </div>
          <div className="pair">
            <label>インの形
              <select value={clip.fade_in_curve} onChange={ev => update({ ...clip, fade_in_curve: +ev.target.value }, `fic-${Date.now()}`)}>
                {CURVES.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
                {!CURVES.some(c => c.v === clip.fade_in_curve) && <option value={clip.fade_in_curve}>カーブ {clip.fade_in_curve}</option>}
              </select></label>
            <label>アウトの形
              <select value={clip.fade_out_curve} onChange={ev => update({ ...clip, fade_out_curve: +ev.target.value }, `foc-${Date.now()}`)}>
                {CURVES.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
                {!CURVES.some(c => c.v === clip.fade_out_curve) && <option value={clip.fade_out_curve}>カーブ {clip.fade_out_curve}</option>}
              </select></label>
          </div>
        </details>
        <details open>
          <summary>音量カーブ</summary>
          <div className="kftable">
            {clip.keyframes.length === 0 && <div className="hint">点なし</div>}
            {clip.keyframes.map((k, i) => (
              <div key={i} className={`kfrow${selKf === i ? ' sel' : ''}`} onClick={() => setSelKf(i)}>
                <span className="mono" title="完成版の時刻">{formatTime(s + k.t, 2)}</span>
                <input type="number" step={0.5} value={Math.round(k.db * 10) / 10} aria-label={`点${i + 1}の音量（dB）`}
                  onChange={ev => ev.target.value !== '' && update(moveKeyframe(clip, i, k.t, +ev.target.value).clip, `kfdb-${i}`)} />
                <button className="btn icon" aria-label={`点${i + 1}を削除`} title="削除"
                  onClick={ev => { ev.stopPropagation(); update(removeKeyframe(clip, i), `kf-del-${Date.now()}`); setSelKf(null) }}>×</button>
              </div>
            ))}
          </div>
          <button className="btn" title="再生位置（曲の外なら真ん中）に点を足す" onClick={() => {
            const pos = player.position()
            const t = pos > s && pos < e ? pos - s : clip.duration / 2
            update(addKeyframe(clip, t), `kf-add-${Date.now()}`)
          }}>＋ 点を追加</button>
        </details>
      </aside>
    </div>
  )
}

function Num({ label, value, step, min, onChange, title }: { label: string; value: number; step: number; min?: number; onChange: (v: number) => void; title?: string }) {
  const [text, setText] = useState(String(Math.round(value * 1000) / 1000))
  useEffect(() => { setText(String(Math.round(value * 1000) / 1000)) }, [value])
  return (
    <label title={title}>{label}
      <input type="number" step={step} min={min} value={text}
        onChange={e => { setText(e.target.value); if (e.target.value !== '' && !isNaN(+e.target.value)) onChange(+e.target.value) }} />
    </label>
  )
}

// ---------------------------------------------------------------- 波形とカーブ

interface LanesProps {
  project: Project; clip: BgmClip; player: Player; peaks: Record<string, Peaks>; colors: string[]
  win: { start: number; span: number }; setWin: (w: { start: number; span: number }) => void
  selKf: number | null; setSelKf: (i: number | null) => void; fileDur?: number
  update: (c: BgmClip, group: string, opts?: ChangeOpts) => void; lastWords?: string; which: 'op' | 'ed'
  bgmH: number; onResetView: () => void; onLaneStart: () => void; onLaneDrag: (d: number) => void
}

const VOICE_H = 90

function Lanes(p: LanesProps) {
  const { project, clip, win, peaks } = p
  const BGM_H = p.bgmH
  const [ref, w] = useWidth()
  const box = useRef<HTMLDivElement>(null)
  const s = clipStart(project, clip), e = clipEnd(project, clip)
  const x = (t: number) => ((t - win.start) / win.span) * w
  const tAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return win.start + ((clientX - r.left) / r.width) * win.span
  }
  const yOf = (db: number) => 8 + ((DB_TOP - Math.max(DB_BOTTOM, Math.min(DB_TOP, db))) / (DB_TOP - DB_BOTTOM)) * (BGM_H - 16)
  const dbAt = (clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return DB_TOP - ((clientY - r.top - 8) / (BGM_H - 16)) * (DB_TOP - DB_BOTTOM)
  }
  useWheel(box, ref, win, p.setWin)

  // ドラッグ：動かしている間は鳴らし直さず、離したときに鳴らし直す
  const drag = (onMove: (ev: PointerEvent) => BgmClip, group: string) => (ev: React.PointerEvent) => {
    ev.preventDefault(); ev.stopPropagation()
    const target = ev.currentTarget as HTMLElement
    target.setPointerCapture(ev.pointerId)
    let last: BgmClip | null = null
    const move = (m: PointerEvent) => { last = onMove(m); p.update(last, group, { restart: false }) }
    const up = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up)
      if (last) p.update(last, group, { restart: true })
    }
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up)
  }
  const laneEl = useRef<HTMLDivElement>(null)
  const ticks = rulerTicks(win.start, win.start + win.span, Math.max(2, Math.floor(w / 90)))
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1
  const fadeInX = x(s + clip.fade_in), fadeOutX = x(e - clip.fade_out)
  const voiceStart = project.edit.position, voiceEnd = outputEnd(project.edit)

  return (
    <div className="bgmlanes" ref={box}>
      <div className="trow">
        <div />
        <div ref={ref} className="ruler seekable" title="クリック・ドラッグで再生位置を移す（ダブルクリックで表示を元に戻す）"
          onPointerDown={scrubHandler(f => p.player.seek(win.start + f * win.span))} onDoubleClick={p.onResetView}>
          {w > 0 && ticks.map(t => <div key={t} style={{ left: x(t) }}><span className="mono">{formatTime(t, step < 1 ? 1 : 0)}</span></div>)}
        </div>
      </div>
      <div className="trow">
        <div className="tlabel"><b><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--bgm)' }} />BGM</b>
          <small>{clip.source} ・ {formatDb(clip.gain_db)}</small></div>
        <div className="lane" ref={laneEl} style={{ height: BGM_H, cursor: 'crosshair' }}
          onClick={ev => { if (ev.target === ev.currentTarget || (ev.target as HTMLElement).tagName === 'CANVAS') { p.setSelKf(null); p.player.seek(tAt(ev.clientX)) } }}
          onDoubleClick={ev => {
            const t = tAt(ev.clientX)
            if (t < s || t > e) return
            const db = dbAt(ev.clientY, laneEl.current!) - clip.gain_db
            const c = addKeyframe(clip, t - s, Math.round(db * 10) / 10)
            p.update(c, `kf-add-${Date.now()}`)
            p.setSelKf(c.keyframes.findIndex(k => Math.abs(k.t - (t - s)) < 1e-6))
          }}>
          <BgmCanvas clip={clip} start={s} peaks={peaks[clip.source]} win={win} width={w} yOf={yOf} />
          {/* 0 dB の点線 */}
          <div className="zero" style={{ top: yOf(0) }}><span>0 dB</span></div>
          {/* 始まり・切る位置 */}
          <div className="edge" style={{ left: x(s) }} title="始まり（ドラッグで頭を削る・のばす）"
            onPointerDown={drag(m => moveStart(project, clip, tAt(m.clientX), { keepEnd: true, fileDuration: p.fileDur }), 'bgm-start')} />
          <div className="edge" style={{ left: x(e) }} title="切る位置（ドラッグ）"
            onPointerDown={drag(m => moveEnd(project, clip, tAt(m.clientX), p.fileDur), 'bgm-end')} />
          {/* フェードの長さ */}
          <div className="fadeh" style={{ left: fadeInX }} title={`フェードイン ${clip.fade_in.toFixed(1)} 秒`}
            onPointerDown={drag(m => setFade(clip, 'in', tAt(m.clientX) - s), 'bgm-fin')} />
          <div className="fadeh" style={{ left: fadeOutX }} title={`フェードアウト ${clip.fade_out.toFixed(1)} 秒`}
            onPointerDown={drag(m => setFade(clip, 'out', e - tAt(m.clientX)), 'bgm-fout')} />
          {/* 音量の点 */}
          {clip.keyframes.map((k, i) => (
            <button key={i} className={`kf${p.selKf === i ? ' sel' : ''}`} style={{ left: x(s + k.t), top: yOf(clip.gain_db + k.db) }}
              aria-label={`点${i + 1}：${formatTime(s + k.t, 2)} ${formatDb(k.db)}`} title={`${formatTime(s + k.t, 2)} ・ ${formatDb(k.db)}`}
              onClick={ev => { ev.stopPropagation(); p.setSelKf(i) }} onDoubleClick={ev => ev.stopPropagation()}
              onPointerDown={ev => {
                p.setSelKf(i)
                drag(m => moveKeyframe(clip, i, tAt(m.clientX) - s, Math.round((dbAt(m.clientY, laneEl.current!) - clip.gain_db) * 10) / 10).clip, `kf-${i}`)(ev)
              }} />
          ))}
          {p.selKf != null && clip.keyframes[p.selKf] && (
            <div className="kflabel" style={{ left: x(s + clip.keyframes[p.selKf].t), top: yOf(clip.gain_db + clip.keyframes[p.selKf].db) }}>
              点{p.selKf + 1}：{formatDb(clip.keyframes[p.selKf].db)}
            </div>
          )}
          <OutPlayLine player={p.player} win={win} width={w} />
        </div>
      </div>
      <div className="trow">
        <div />
        <Splitter dir="row" label="BGM の波形の高さ" onStart={p.onLaneStart} onDrag={p.onLaneDrag} />
      </div>
      <div className="trow">
        <div className="tlabel"><b>声</b><small>{project.voices.map(v => v.name).join('・')}</small></div>
        <div className="lane" style={{ height: VOICE_H }} onClick={ev => p.player.seek(tAt(ev.clientX))}>
          <VoiceCanvas project={project} peaks={peaks} colors={p.colors} win={win} width={w} />
          {[{ t: voiceStart, label: `話し始め ${formatTime(voiceStart)}` }, { t: voiceEnd, label: `話の終わり ${formatTime(voiceEnd)}` }]
            .filter(m => m.t >= win.start && m.t <= win.start + win.span).map(m => (
              <div key={m.label} className="marker" style={{ left: x(m.t) }}><span>{m.label}</span></div>
            ))}
          <OutPlayLine player={p.player} win={win} width={w} />
        </div>
      </div>
    </div>
  )
}

function OutPlayLine({ player, win, width }: { player: Player; win: { start: number; span: number }; width: number }) {
  const left = usePlayhead(player, t => Math.round(((t - win.start) / win.span) * width))
  if (left < 0 || left > width) return null
  return <div className="playline" style={{ left }} />
}

/** ピンチで拡大・縮小、2本指の左右で移動（編集画面の波形と同じ操作） */
function useWheel(box: React.RefObject<HTMLDivElement | null>, ruler: React.RefObject<HTMLDivElement | null>,
  win: { start: number; span: number }, setWin: (w: { start: number; span: number }) => void) {
  const latest = useRef({ win, setWin })
  latest.current = { win, setWin }
  const pending = useRef<{ start: number; span: number } | null>(null)
  const seen = useRef(win)
  if (seen.current !== win) { seen.current = win; pending.current = null }
  useEffect(() => {
    const el = box.current
    if (!el) return
    const cur = () => pending.current ?? latest.current.win
    const apply = (v: { start: number; span: number }) => { pending.current = v; latest.current.setWin(v) }
    const zoomAt = (span: number, clientX: number, base = cur()) => {
      const r = ruler.current?.getBoundingClientRect()
      const frac = r && r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0.5
      const t = base.start + frac * base.span
      span = Math.min(Math.max(1, span), 3600)
      apply({ start: t - frac * span, span })
    }
    const onWheel = (e: WheelEvent) => {
      const v = cur()
      if (e.ctrlKey) { e.preventDefault(); zoomAt(v.span * Math.exp(e.deltaY * 0.01), e.clientX); return }
      const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (!horiz) return
      e.preventDefault()
      apply({ ...v, start: v.start + (horiz / (ruler.current?.clientWidth || 1)) * v.span })
    }
    let startWin: { start: number; span: number } | null = null
    const gs = (e: Event) => { e.preventDefault(); startWin = cur() }
    const gc = (e: Event) => { e.preventDefault(); const g = e as Event & { scale: number; clientX: number }; if (startWin && g.scale > 0) zoomAt(startWin.span / g.scale, g.clientX, startWin) }
    const ge = (e: Event) => { e.preventDefault(); startWin = null }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', gs); el.addEventListener('gesturechange', gc); el.addEventListener('gestureend', ge)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', gs); el.removeEventListener('gesturechange', gc); el.removeEventListener('gestureend', ge)
    }
  }, [box, ruler])
}

function setupCanvas(cv: HTMLCanvasElement, width: number) {
  const dpr = window.devicePixelRatio || 1, H = cv.clientHeight
  cv.width = Math.round(width * dpr); cv.height = Math.round(H * dpr)
  const g = cv.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, width, H)
  return { g, H }
}

function BgmCanvas({ clip, start, peaks, win, width, yOf }: {
  clip: BgmClip; start: number; peaks?: Peaks; win: { start: number; span: number }; width: number; yOf: (db: number) => number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv || !width) return
    const { g, H } = setupCanvas(cv, width)
    const x = (t: number) => ((t - win.start) / win.span) * width
    const xa = Math.max(0, x(start)), xb = Math.min(width, x(start + clip.duration))
    if (xb <= xa) return
    g.fillStyle = '#2A2440'; g.fillRect(xa, 0, xb - xa, H)
    // 曲の波形（音量カーブをかけた形）
    if (peaks) {
      const n = peaks.min.length, mid = H / 2
      for (let px = Math.floor(xa); px < xb; px++) {
        const ct0 = win.start + (px / width) * win.span - start, ct1 = ct0 + win.span / width
        let i0 = Math.floor((clip.offset_in + ct0) * peaks.rate), i1 = Math.ceil((clip.offset_in + ct1) * peaks.rate)
        i0 = Math.max(0, i0); i1 = Math.min(n, Math.max(i1, i0 + 1))
        let hi = 0
        for (let i = i0; i < i1; i++) hi = Math.max(hi, peaks.max[i], -peaks.min[i])
        const gain = Math.pow(10, clipGainDb(clip, ct0) / 20)
        const a = Math.min(1, (hi / 127) * gain) * (H / 2 - 4)
        g.fillStyle = 'rgba(183,156,255,0.22)'; g.fillRect(px, mid - (hi / 127) * (H / 2 - 4), 1, (hi / 127) * (H - 8))
        g.fillStyle = 'rgba(183,156,255,0.75)'; g.fillRect(px, mid - a, 1, Math.max(1, a * 2))
      }
    }
    // 音量カーブ（フェード込み）
    g.strokeStyle = '#E2D6FF'; g.lineWidth = 2; g.beginPath()
    for (let px = Math.floor(xa); px <= xb; px++) {
      const ct = win.start + (px / width) * win.span - start
      const y = yOf(clipGainDb(clip, Math.min(clip.duration, Math.max(0, ct))))
      if (px === Math.floor(xa)) g.moveTo(px, y); else g.lineTo(px, y)
    }
    g.stroke()
  }, [clip, start, peaks, win, width, yOf])
  return <canvas ref={ref} />
}

function VoiceCanvas({ project, peaks, colors, win, width }: {
  project: Project; peaks: Record<string, Peaks>; colors: string[]; win: { start: number; span: number }; width: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const lay = useMemo(() => layout(project.edit), [project.edit])
  useEffect(() => {
    const cv = ref.current
    if (!cv || !width) return
    const { g, H } = setupCanvas(cv, width)
    const mid = H / 2
    project.voices.forEach((v, vi) => {
      const pk = peaks[v.source]
      if (!pk) return
      g.fillStyle = colors[vi % colors.length]; g.globalAlpha = 0.8
      const n = pk.min.length
      for (let px = 0; px < width; px++) {
        const t = win.start + (px / width) * win.span
        const r = outToRef(project.edit, t)
        if (r == null) continue
        const r1 = r + win.span / width
        let i0 = Math.floor(fileTime(project.sync, v.source, r) * pk.rate), i1 = Math.ceil(fileTime(project.sync, v.source, r1) * pk.rate)
        i0 = Math.max(0, i0); i1 = Math.min(n, Math.max(i1, i0 + 1))
        let hi = 0
        for (let i = i0; i < i1; i++) hi = Math.max(hi, pk.max[i], -pk.min[i])
        const a = (hi / 127) * (H / 2 - 4)
        g.fillRect(px, mid - a, 1, Math.max(1, a * 2))
      }
    })
    g.globalAlpha = 1
  }, [project, lay, peaks, colors, win, width])
  return <canvas ref={ref} />
}
