// Google ログイン（Google Identity Services のトークン方式）。
// 受け取るのは 1 時間で切れる「読み取り専用」の鍵だけ。パスワードはこのページを通らない
declare global {
  interface Window { google?: any } // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const KEY = 'listen.token'

interface Saved { token: string; exp: number }

function load(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null
    return s && s.exp > Date.now() + 60_000 ? s : null
  } catch { return null }
}

let saved: Saved | null = load()
export const token = () => (saved && saved.exp > Date.now() + 30_000 ? saved.token : null)

let gis: Promise<void> | null = null
function loadGis(): Promise<void> {
  return gis ??= new Promise((ok, ng) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => ok()
    s.onerror = () => { gis = null; ng(new Error('Google のログイン部品を読み込めませんでした。通信を確かめてください')) }
    document.head.appendChild(s)
  })
}

/** 先に読み込んでおく（iPhone ではボタンを押したその場でないとログインの窓が開けないため） */
export const prepare = (clientId: string) => clientId ? loadGis().catch(() => {}) : Promise.resolve()

/** ログインの窓を開く。ボタンを押したときに呼ぶ */
export async function signIn(clientId: string): Promise<void> {
  await loadGis()
  await new Promise<void>((ok, ng) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      prompt: '',
      callback: (r: { access_token?: string; expires_in?: number; error?: string }) => {
        if (!r.access_token) { ng(new Error(r.error === 'access_denied' ? 'ログインを取りやめました' : `ログインできませんでした（${r.error ?? '不明'}）`)); return }
        saved = { token: r.access_token, exp: Date.now() + (r.expires_in ?? 3600) * 1000 }
        try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch { /* 保存できなくても今は使える */ }
        ok()
      },
      error_callback: (e: { type?: string }) => ng(new Error(e.type === 'popup_closed' ? 'ログインの窓が閉じられました' : 'ログインの窓を開けませんでした')),
    })
    client.requestAccessToken()
  })
}

export function signOut() {
  const t = saved?.token
  saved = null
  try { localStorage.removeItem(KEY) } catch { /* なし */ }
  if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t, () => {})
}
