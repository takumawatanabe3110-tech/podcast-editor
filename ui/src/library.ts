// 番組・回の一覧（ライブラリ）とのやり取り。
async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try { msg = (await r.json()).detail ?? msg } catch { /* 本文が JSON でない */ }
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}

export interface Member { name: string; role: 'mc' | 'guest' | string; voiceprint?: string | null }
export interface Program {
  format?: string; version?: number
  name: string; preset?: string | null
  bgm?: Record<string, string>
  members?: Member[]
}
export interface Episode {
  id: string; title?: string; date?: string
  has_project?: boolean; has_transcript?: boolean
  exported?: { path: string; size: number; mtime: number } | null
  duration?: number | null
}
export interface ProgramEntry extends Program { id: string; episodes: Episode[] }
export interface Library { root: string; programs: ProgramEntry[] }
export interface Current { program: string; episode: string }
export interface JobStatus { state: 'running' | 'done' | 'error' | 'idle'; stage?: string; progress?: number; remaining?: number | null; message?: string }

const enc = encodeURIComponent

export const getLibrary = () => fetch('/api/library').then(r => json<Library>(r))
export const getCurrent = () => fetch('/api/current').then(r => json<Current | null>(r))
export const openEpisode = (program: string, episode: string) =>
  fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ program, episode }) }).then(r => json<unknown>(r))
export const createProgram = (name: string, preset?: string) =>
  fetch('/api/programs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, preset }) }).then(r => json<ProgramEntry>(r))
export const saveProgram = (id: string, p: Program) =>
  fetch(`/api/programs/${enc(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(r => json<Program>(r))
export const uploadBgm = (id: string, role: string, file: File) => {
  const fd = new FormData(); fd.append('role', role); fd.append('file', file)
  return fetch(`/api/programs/${enc(id)}/bgm`, { method: 'POST', body: fd }).then(r => json<Program>(r))
}
export const enrollVoiceprint = (id: string, name: string, episode: string, source: string, role?: string) =>
  fetch(`/api/programs/${enc(id)}/members/${enc(name)}/voiceprint`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episode, source, role }),
  }).then(r => json<Member>(r))
export const deleteMember = (id: string, name: string) =>
  fetch(`/api/programs/${enc(id)}/members/${enc(name)}`, { method: 'DELETE' }).then(r => json<unknown>(r))
export const createEpisode = (id: string, date: string, files: File[]) => {
  const fd = new FormData(); fd.append('date', date)
  for (const f of files) fd.append('files', f)
  return fetch(`/api/programs/${enc(id)}/episodes`, { method: 'POST', body: fd }).then(r => json<{ id: string }>(r))
}
export const episodeStatus = (id: string, ep: string) =>
  fetch(`/api/programs/${enc(id)}/episodes/${enc(ep)}/status`).then(r => json<JobStatus>(r))
