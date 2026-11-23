// Google ログイン。ページごと Google のログイン画面へ移り、終わるとこのページへ戻ってくる方式
// （小窓（ポップアップ）方式は iPhone の Safari やホーム画面から開いたときに失敗するため使わない）。
// 受け取るのは 1 時間で切れる「読み取り専用」の鍵だけ。パスワードはこのページを通らない
import { readReturn, type Saved } from './logic'
export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const KEY = 'listen.token'
const STATE_KEY = 'listen.state'

function load(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null
    return s && s.exp > Date.now() + 60_000 ? s : null
  } catch { return null }
}

/** 戻り先（Google の設定の「承認済みのリダイレクト URI」に同じものを入れておく） */
export const redirectUri = () => location.origin + location.pathname

let saved: Saved | null = load()
/** 戻ってきたときのエラー（ログイン画面に出す） */
export let returnError = ''

{
  let expect: string | null = null
  try { expect = localStorage.getItem(STATE_KEY) } catch { /* なし */ }
  const r = readReturn(location.hash, expect)
  if (r) {
    try { localStorage.removeItem(STATE_KEY) } catch { /* なし */ }
    history.replaceState(null, '', location.pathname + location.search) // 鍵をアドレス欄に残さない
    if (r.saved) {
      saved = r.saved
      try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch { /* 保存できなくても今は使える */ }
    } else returnError = r.error ?? ''
  }
}

export const token = () => (saved && saved.exp > Date.now() + 30_000 ? saved.token : null)

/** Google のログイン画面へ移る。ボタンを押したときに呼ぶ（このページはいったん離れる） */
export function signIn(clientId: string) {
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
  try { localStorage.setItem(STATE_KEY, state) } catch { /* なし */ }
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(), response_type: 'token',
    scope: SCOPE, include_granted_scopes: 'true', state,
  })
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString())
}

export function signOut() {
  const t = saved?.token
  saved = null
  try { localStorage.removeItem(KEY) } catch { /* なし */ }
  if (t) void fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: t }) }).catch(() => {})
}
