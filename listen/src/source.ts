// 完成版の読み先。本番は Google Drive、手元で試すときは public/demo/（?demo）
import { parseEpisode, type ListenEpisode } from './logic'

export interface Entry { ep: ListenEpisode; ref: string; folder: string }
export interface Source {
  kind: 'drive' | 'demo'
  list(): Promise<Entry[]>
  /** 音声を読み込んで、<audio> に渡せる URL を返す */
  audio(e: Entry, onProgress: (frac: number) => void): Promise<string>
}

/** 読み込みの進み具合を見ながら Blob にする */
async function readWithProgress(res: Response, onProgress: (frac: number) => void, type = 'audio/mpeg'): Promise<Blob> {
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body || !total) { const b = await res.blob(); onProgress(1); return new Blob([b], { type }) }
  const reader = res.body.getReader(), parts: BlobPart[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value as Uint8Array<ArrayBuffer>); got += value.length
    onProgress(Math.min(1, got / total))
  }
  return new Blob(parts, { type })
}

// ---------------------------------------------------------------- 手元で試す（public/demo/index.json に .listen.json の名前を並べる）

export function demoSource(base = './demo/'): Source {
  return {
    kind: 'demo',
    async list() {
      const names: string[] = await (await fetch(base + 'index.json')).json()
      const out: Entry[] = []
      for (const n of names) {
        const ep = parseEpisode(await (await fetch(base + encodeURIComponent(n))).json())
        if (ep) out.push({ ep, ref: n, folder: base })
      }
      return out
    },
    async audio(e, onProgress) {
      const res = await fetch(e.folder + encodeURIComponent(e.ep.audio))
      if (!res.ok) throw new Error(`音声が見つかりません（${e.ep.audio}）`)
      return URL.createObjectURL(await readWithProgress(res, onProgress))
    },
  }
}

// ---------------------------------------------------------------- Google Drive

const API = 'https://www.googleapis.com/drive/v3/files'
export class AuthError extends Error {}

/** Drive の検索式の文字列（' と \ を逃がす） */
export const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export function driveSource(getToken: () => string | null): Source {
  const call = async (url: string): Promise<Response> => {
    const token = getToken()
    if (!token) throw new AuthError('ログインが切れました')
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 401) throw new AuthError('ログインが切れました')
    if (!res.ok) throw new Error(`Google Drive から読めませんでした（${res.status}）`)
    return res
  }
  return {
    kind: 'drive',
    async list() {
      const files: { id: string; parents?: string[] }[] = []
      let page = ''
      do {
        const params = new URLSearchParams({
          q: "name contains '.listen.json' and trashed = false",
          fields: 'nextPageToken, files(id, name, parents)', pageSize: '200', spaces: 'drive',
        })
        if (page) params.set('pageToken', page)
        const d = await (await call(`${API}?${params}`)).json()
        files.push(...(d.files ?? []))
        page = d.nextPageToken ?? ''
      } while (page)
      const out: Entry[] = []
      // 小さなファイルなので 6 本ずつまとめて読む
      for (let i = 0; i < files.length; i += 6) {
        await Promise.all(files.slice(i, i + 6).map(async f => {
          try {
            const ep = parseEpisode(await (await call(`${API}/${f.id}?alt=media`)).json())
            if (ep) out.push({ ep, ref: f.id, folder: f.parents?.[0] ?? '' })
          } catch (e) { if (e instanceof AuthError) throw e } // 1つ読めなくても一覧は出す
        }))
      }
      return out
    },
    async audio(e, onProgress) {
      const params = new URLSearchParams({
        q: `name = ${q(e.ep.audio)} and trashed = false${e.folder ? ` and ${q(e.folder)} in parents` : ''}`,
        fields: 'files(id, size)', pageSize: '1', spaces: 'drive',
      })
      const d = await (await call(`${API}?${params}`)).json()
      const id = d.files?.[0]?.id
      if (!id) throw new Error(`音声がまだ Google Drive にありません（${e.ep.audio}）。Mac の同期が終わるまで待ってください`)
      return URL.createObjectURL(await readWithProgress(await call(`${API}/${id}?alt=media`), onProgress))
    },
  }
}
