// 画面の広さ（台本の幅、ミキサーの高さなど）。境目をドラッグして変え、次に開いたときも同じにする。
import { useCallback, useEffect, useState } from 'react'

export interface Layout {
  scriptOpen: boolean; scriptW: number
  mixerOpen: boolean; mixerH: number; mixerAuto: boolean // mixerAuto：波形の高さに合わせて、残りをミキサーにする
  bgmSideW: number; bgmLaneH: number
}

const KEY = 'podcast-editor-layout'
const DEFAULT: Layout = { scriptOpen: true, scriptW: 380, mixerOpen: true, mixerH: 230, mixerAuto: true, bgmSideW: 340, bgmLaneH: 220 }

function load(): Layout {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return DEFAULT }
}

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(load)
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(layout)) } catch { /* 保存できなくても動く */ } }, [layout])
  const set = useCallback((patch: Partial<Layout>) => setLayout(l => ({ ...l, ...patch })), [])
  return [layout, set] as const
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * 境目。dir="col" は左右の境目（横にドラッグ）、"row" は上下の境目（縦にドラッグ）。
 * onDrag には、押した位置からの移動量（px）を渡す。onStart で今の広さを覚えておく。
 */
export function Splitter({ dir, label, onStart, onDrag, onDoubleClick, children }: {
  dir: 'col' | 'row'; label: string; onStart: () => void; onDrag: (delta: number) => void
  onDoubleClick?: () => void; children?: React.ReactNode
}) {
  return (
    <div className={`splitter ${dir}`} role="separator" aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'} aria-label={label}
      title="ドラッグで広さを変える"
      onDoubleClick={onDoubleClick}
      onPointerDown={e => {
        if ((e.target as HTMLElement).closest('button')) return
        e.preventDefault()
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        const x0 = e.clientX, y0 = e.clientY
        onStart()
        document.body.classList.add(dir === 'col' ? 'resizing-col' : 'resizing-row')
        const move = (m: PointerEvent) => onDrag(dir === 'col' ? m.clientX - x0 : m.clientY - y0)
        const up = () => {
          el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up)
          document.body.classList.remove('resizing-col', 'resizing-row')
        }
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up)
      }}>
      {children}
    </div>
  )
}

/**
 * 目盛りのクリック・ドラッグで再生位置を動かす。seek には 0〜1（左端〜右端）の位置を渡す。
 * 押したまま横に動かすと、再生位置もついてくる。
 */
export function scrubHandler(seek: (frac: number) => void) {
  return (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const at = (x: number) => seek(clamp((x - rect.left) / rect.width, 0, 1))
    el.setPointerCapture(e.pointerId)
    at(e.clientX)
    let last = 0
    const move = (m: PointerEvent) => {
      const now = performance.now()
      if (now - last < 40) return // 鳴らし直しが多すぎないように間引く
      last = now
      at(m.clientX)
    }
    const up = (u: PointerEvent) => {
      at(u.clientX)
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up)
  }
}
