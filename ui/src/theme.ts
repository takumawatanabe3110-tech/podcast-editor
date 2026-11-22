// 画面の明るさ（Mac の外観）に合わせて、キャンバスに描く色を切り替える。
import { useSyncExternalStore } from 'react'

const query = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null)

export const isDark = () => query()?.matches ?? true

/** 外観が変わったら描き直せるように、キャンバスの effect の依存に入れる */
export function useDark() {
  return useSyncExternalStore(cb => { const m = query(); m?.addEventListener('change', cb); return () => m?.removeEventListener('change', cb) }, isDark)
}

/** 文字・線の色（暗い背景では明るく、明るい背景では濃く）。a は不透明度 */
export const ink = (a: number) => (isDark() ? `rgba(236,234,247,${a})` : `rgba(31,29,58,${a})`)
/** 太い主役の線（EQ の合計カーブなど） */
export const strong = () => (isDark() ? '#FFFFFF' : '#1F1D3A')
/** グラフの上の補助の文字 */
export const faint = () => (isDark() ? '#8D8BAA' : '#6E6C8C')
