// いつもの設定（プリセット）を画面のあちこちで使うための入れ物。
import type { Preset } from './api'

export interface PresetCtx {
  names: string[]
  current: string | null // 使うプリセットの名前（プロジェクトに書いてあるもの、なければ最初の1つ）
  setCurrent: (name: string) => void
  data: Preset | null // current の中身
  reload: () => Promise<void>
  flush: () => Promise<void> // 画面の変更をサーバーに保存し終える（保存の前に呼ぶ）
}

type Fx = { type?: string; bands?: unknown[] }

/** プリセットの中の EQ のひな形の一覧（声トラックごと・ゲスト・BGM・マスター） */
export function eqTemplates(p: Preset | null): { label: string; bands: unknown[] }[] {
  if (!p) return []
  const out: { label: string; bands: unknown[] }[] = []
  const eqOf = (fx?: Fx[]) => fx?.find(e => e?.type === 'eq')?.bands
  ;((p.voices ?? []) as { name?: string; effects?: Fx[] }[]).forEach((v, i) => {
    const b = eqOf(v.effects); if (b) out.push({ label: v.name || `声 ${i + 1}`, bands: b })
  })
  const d = eqOf((p.default_voice as { effects?: Fx[] } | undefined)?.effects)
  if (d) out.push({ label: (p.default_voice as { name?: string }).name || 'ゲスト', bands: d })
  const bg = eqOf(p.bgm_effects as Fx[]); if (bg) out.push({ label: 'BGM', bands: bg })
  const ms = eqOf(p.master_effects as Fx[]); if (ms) out.push({ label: 'マスター', bands: ms })
  return out
}
