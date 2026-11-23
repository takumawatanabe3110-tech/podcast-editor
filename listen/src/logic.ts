// 試聴ページの、画面に関係しない計算（テストする部分）

/** 完成版フォルダの .listen.json の中身（エンジンが書き出しのたびに書く） */
export interface ListenLine { speaker: string; text: string; start: number; end: number }
export interface ListenEpisode {
  format: 'podlisten'
  version: number
  program: string
  episode: string // YYYYMMDD
  date: string // YYYY-MM-DD
  members: string[]
  speakers: Record<string, string> // 話者名 → 色
  duration: number
  audio: string // 同じフォルダの MP3 のファイル名
  exported_at: string
  lines: ListenLine[]
}

/** .listen.json として読めるか確かめる。読めなければ null（ほかのファイルが混ざっていても落ちない） */
export function parseEpisode(data: unknown): ListenEpisode | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.format !== 'podlisten' || typeof d.program !== 'string' || typeof d.audio !== 'string') return null
  if (typeof d.episode !== 'string' || !/^\d{8}$/.test(d.episode)) return null
  const lines = Array.isArray(d.lines) ? d.lines.filter((l): l is ListenLine =>
    !!l && typeof l === 'object' && typeof (l as ListenLine).text === 'string'
    && Number.isFinite((l as ListenLine).start) && Number.isFinite((l as ListenLine).end)) : []
  return {
    format: 'podlisten',
    version: typeof d.version === 'number' ? d.version : 1,
    program: d.program,
    episode: d.episode,
    date: typeof d.date === 'string' ? d.date : `${d.episode.slice(0, 4)}-${d.episode.slice(4, 6)}-${d.episode.slice(6)}`,
    members: Array.isArray(d.members) ? d.members.filter((m): m is string => typeof m === 'string') : [],
    speakers: d.speakers && typeof d.speakers === 'object' ? d.speakers as Record<string, string> : {},
    duration: typeof d.duration === 'number' && d.duration > 0 ? d.duration : 0,
    audio: d.audio,
    exported_at: typeof d.exported_at === 'string' ? d.exported_at : '',
    lines: [...lines].sort((a, b) => a.start - b.start),
  }
}

export interface Program { name: string; members: string[]; episodes: ListenEpisode[] }

/** 番組ごとにまとめる。回は新しい順。同じ回が2つあれば書き出しの新しい方 */
export function groupPrograms(eps: ListenEpisode[]): Program[] {
  const byKey = new Map<string, ListenEpisode>()
  for (const e of eps) {
    const k = `${e.program}\u0000${e.episode}`
    const prev = byKey.get(k)
    if (!prev || e.exported_at > prev.exported_at) byKey.set(k, e)
  }
  const progs = new Map<string, Program>()
  for (const e of byKey.values()) {
    let p = progs.get(e.program)
    if (!p) progs.set(e.program, p = { name: e.program, members: [], episodes: [] })
    p.episodes.push(e)
  }
  for (const p of progs.values()) {
    p.episodes.sort((a, b) => b.episode.localeCompare(a.episode))
    p.members = p.episodes[0].members.length ? p.episodes[0].members : [...new Set(p.episodes[0].lines.map(l => l.speaker))]
  }
  return [...progs.values()].sort((a, b) => b.episodes[0].episode.localeCompare(a.episodes[0].episode))
}

/** 時刻 t にしゃべっている（なければ直前の）文の番号。始まる前は -1 */
export function lineAt(lines: ListenLine[], t: number): number {
  let lo = 0, hi = lines.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].start <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

/** 3:05 や 1:02:03 の形 */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

export const SPEEDS = [1, 1.25, 1.5, 2, 0.75]
export function nextSpeed(cur: number): number {
  const i = SPEEDS.indexOf(cur)
  return SPEEDS[(i + 1) % SPEEDS.length]
}

/** 聴いた位置の記録（この端末だけ）。最後の 30 秒まで聴いたら「聴いた」 */
export interface Progress { pos: number; done: boolean }
export const DONE_MARGIN = 30
export function updateProgress(prev: Progress | undefined, pos: number, duration: number): Progress {
  const done = (prev?.done ?? false) || (duration > 0 && pos >= duration - DONE_MARGIN)
  return { pos: duration > 0 && pos >= duration - 1 ? 0 : pos, done }
}

/** 一覧の札：再生中／新しい（まだ一度も聴いていない）／途中／聴いた */
export function episodeBadge(p: Progress | undefined, playing: boolean): 'playing' | 'new' | 'partial' | 'done' {
  if (playing) return 'playing'
  if (!p) return 'new'
  if (p.done) return 'done'
  return p.pos > 0 ? 'partial' : 'new'
}

export const episodeKey = (e: Pick<ListenEpisode, 'program' | 'episode'>) => `${e.program}/${e.episode}`

// ---------------------------------------------------------------- ログインから戻ったとき

export interface Saved { token: string; exp: number }

/** Google から戻ってきたときの #access_token=… を読む。失敗の理由があれば返す */
export function readReturn(hash: string, expectState: string | null, now = Date.now()): { saved?: Saved; error?: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  if (!p.has('access_token') && !p.has('error')) return null
  if (!expectState || p.get('state') !== expectState) return { error: 'ログインをやり直してください（確認の印が合いませんでした）' }
  const err = p.get('error')
  if (err) return { error: err === 'access_denied' ? 'ログインを取りやめました' : `ログインできませんでした（${err}）` }
  const exp = now + Number(p.get('expires_in') || 3600) * 1000
  return { saved: { token: p.get('access_token')!, exp } }
}
