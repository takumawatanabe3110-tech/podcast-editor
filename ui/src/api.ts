import type { Peaks, Project, ProjectResponse, Transcript } from './types'

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try { msg = (await r.json()).detail ?? msg } catch { /* 本文が JSON でない */ }
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}

export const getProject = () => fetch('/api/project').then(r => json<ProjectResponse>(r))

export const putProject = (p: Project) =>
  fetch('/api/project', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    .then(r => json<ProjectResponse>(r))

/** 文字起こしがまだなければ null */
export async function getTranscript(): Promise<Transcript | null> {
  const r = await fetch('/api/transcript')
  if (r.status === 404) return null
  return json<Transcript>(r)
}

export const putTranscript = (t: Transcript) =>
  fetch('/api/transcript', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) })
    .then(r => json<Transcript>(r))

export const getPeaks = (sid: string) => fetch(`/api/peaks/${encodeURIComponent(sid)}`).then(r => json<Peaks>(r))

/** 試聴用の音。raw＝ノイズ除去をかける前の音 */
export const getAudio = (sid: string, raw = false) =>
  fetch(`/api/audio/${encodeURIComponent(sid)}${raw ? '?raw=1' : ''}`).then(r => {
    if (!r.ok) throw new Error(`音声 ${sid} を読めません（${r.status}）`)
    return r.arrayBuffer()
  })

export const startExport = () =>
  fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => json<{ state: string; path: string }>(r))

export const getExport = () => fetch('/api/export').then(r => json<import('./Mixer').ExportStatus>(r))

// ---- いつもの設定（プリセット）
export type Preset = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export const listPresets = () => fetch('/api/presets').then(r => json<{ name: string; description?: string }[]>(r))
export const getPreset = (name: string) => fetch(`/api/presets/${encodeURIComponent(name)}`).then(r => json<Preset>(r))
/** プロジェクト（保存済みのもの）の BGM の置き方を、プリセットに書き込む */
export const savePresetBgm = (name: string, source: string) =>
  fetch(`/api/presets/${encodeURIComponent(name)}/bgm/${encodeURIComponent(source)}`, { method: 'PUT' }).then(r => json<{ entry: unknown }>(r))
/** トラックのエフェクトをプリセットに書き込む。track は "voice:0" / "bgm" / "master" */
export const savePresetEffects = (name: string, track: string, effects: unknown[]) =>
  fetch(`/api/presets/${encodeURIComponent(name)}/effects/${encodeURIComponent(track)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effects }),
  }).then(r => json<unknown>(r))
