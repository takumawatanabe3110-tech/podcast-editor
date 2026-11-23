import type { Peaks, Project, ProjectResponse, Transcript } from './types'

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try { msg = (await r.json()).detail ?? msg } catch { /* 本文が JSON でない */ }
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}

// ---- 開いている回
// サーバーを起動し直すと、サーバーは開いていた回を忘れることがある。そのときは画面が開いている回を
// 開き直してから、もう一度送る（保存・書き出しが「エピソードを開いていません」で失敗しないように）
let opened: { program: string; episode: string } | null = null
export const setOpened = (c: { program: string; episode: string } | null) => { opened = c?.program && c.episode ? c : null }

const NOT_OPEN = '開いていません'
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(url, init)
  if (r.status !== 404 || !opened) return r
  let detail = ''
  try { detail = String((await r.clone().json()).detail ?? '') } catch { /* 本文が JSON でない */ }
  if (!detail.includes(NOT_OPEN)) return r
  const o = await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opened) })
  return o.ok ? fetch(url, init) : r
}

export const getProject = () => apiFetch('/api/project').then(r => json<ProjectResponse>(r))

export const putProject = (p: Project) =>
  apiFetch('/api/project', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    .then(r => json<ProjectResponse>(r))

/** 文字起こしがまだなければ null */
export async function getTranscript(): Promise<Transcript | null> {
  const r = await apiFetch('/api/transcript')
  if (r.status === 404) return null
  return json<Transcript>(r)
}

export const putTranscript = (t: Transcript) =>
  apiFetch('/api/transcript', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) })
    .then(r => json<Transcript>(r))

export const getPeaks = (sid: string) => apiFetch(`/api/peaks/${encodeURIComponent(sid)}`).then(r => json<Peaks>(r))

/** 試聴用の音。raw＝ノイズ除去をかける前の音 */
export const getAudio = (sid: string, raw = false) =>
  apiFetch(`/api/audio/${encodeURIComponent(sid)}${raw ? '?raw=1' : ''}`).then(r => {
    if (!r.ok) throw new Error(`音声 ${sid} を読めません（${r.status}）`)
    return r.arrayBuffer()
  })

export const startExport = () =>
  apiFetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => json<{ state: string; path: string }>(r))

export const getExport = () => apiFetch('/api/export').then(r => json<import('./Mixer').ExportStatus>(r))

// ---- いつもの設定（プリセット）
export type Preset = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export const listPresets = () => apiFetch('/api/presets').then(r => json<{ name: string; description?: string }[]>(r))
export const getPreset = (name: string) => apiFetch(`/api/presets/${encodeURIComponent(name)}`).then(r => json<Preset>(r))
/** プロジェクト（保存済みのもの）の BGM の置き方を、プリセットに書き込む */
export const savePresetBgm = (name: string, source: string) =>
  apiFetch(`/api/presets/${encodeURIComponent(name)}/bgm/${encodeURIComponent(source)}`, { method: 'PUT' }).then(r => json<{ entry: unknown }>(r))
/** トラックのエフェクトをプリセットに書き込む。track は "voice:0" / "bgm" / "master" */
export const savePresetEffects = (name: string, track: string, effects: unknown[]) =>
  apiFetch(`/api/presets/${encodeURIComponent(name)}/effects/${encodeURIComponent(track)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effects }),
  }).then(r => json<unknown>(r))
