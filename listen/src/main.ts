// 試聴ページ（スマホ用）：① ログイン → ② 回の一覧 → ③ 再生画面（文字起こしつき）
import './style.css'
import * as auth from './auth'
import { episodeBadge, episodeKey, fmtTime, groupPrograms, lineAt, nextSpeed, updateProgress, type Program, type Progress } from './logic'
import { AuthError, demoSource, driveSource, type Entry, type Source } from './source'

const CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''
const DEMO = new URLSearchParams(location.search).has('demo')
const source: Source = DEMO ? demoSource() : driveSource(auth.token)

// ---------------------------------------------------------------- 状態

type Screen = 'login' | 'list' | 'player'
const st = {
  screen: (DEMO || auth.token() ? 'list' : 'login') as Screen,
  loading: false,
  error: auth.returnError,
  entries: [] as Entry[],
  programs: [] as Program[],
  prog: 0, // 選んでいる番組
  current: null as Entry | null, // 再生している回
  audioLoading: -1, // 音声の読み込みの進み具合（-1 は読み込んでいない）
  follow: true, // 文字起こしを今の文に合わせて動かす
  signingIn: false,
}

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) as T } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 保存できなくても続ける */ } },
}
const progress: Record<string, Progress> = store.get('listen.progress', {})
let speed = store.get('listen.speed', 1)

const audio = new Audio()
audio.preload = 'auto'
let audioUrl = ''

// ---------------------------------------------------------------- 小さな DOM の道具

type Child = Node | string | null | false | undefined
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (k === 'class') el.className = String(v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids) if (c != null && c !== false) el.append(c)
  return el
}
function svg(path: string, size = 20, fill = false): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', String(size)); s.setAttribute('height', String(size))
  s.setAttribute('aria-hidden', 'true')
  if (fill) s.setAttribute('fill', 'currentColor')
  else { s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round') }
  s.innerHTML = path // 中身はこのファイルの定数だけ
  return s
}
const I = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>',
  rew: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">15</text>',
  fwd: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">15</text>',
  lines: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/>',
  phones: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  google: '<path d="M20 12.2c0-.6-.1-1.2-.2-1.7H12v3.3h4.5a4 4 0 0 1-1.7 2.6v2.1h2.7c1.6-1.5 2.5-3.7 2.5-6.3z"/><path d="M12 20c2.3 0 4.2-.8 5.5-2.1l-2.7-2.1c-.7.5-1.7.8-2.8.8-2.2 0-4-1.5-4.7-3.4H4.5v2.2A8 8 0 0 0 12 20z"/><path d="M7.3 13.2a4.8 4.8 0 0 1 0-3.1V7.9H4.5a8 8 0 0 0 0 7.2z"/><path d="M12 6.7c1.2 0 2.3.4 3.2 1.2l2.4-2.4A8 8 0 0 0 4.5 7.9l2.8 2.2C8 8.2 9.8 6.7 12 6.7z"/>',
}
const tile = (name: string, cls = 'tile') => h('div', { class: cls, 'aria-hidden': 'true' }, name.trim()[0] ?? '♪')
const prog = () => st.programs[st.prog] as Program | undefined
const speedText = (s: number) => `${Number.isInteger(s) ? s.toFixed(1) : s}×`

// ---------------------------------------------------------------- 読み込み

async function loadList() {
  st.loading = true; st.error = ''; render()
  try {
    st.entries = await source.list()
    st.programs = groupPrograms(st.entries.map(e => e.ep))
    if (st.prog >= st.programs.length) st.prog = 0
  } catch (e) {
    if (e instanceof AuthError) { st.screen = 'login'; st.error = e.message }
    else st.error = e instanceof Error ? e.message : String(e)
  }
  st.loading = false; render()
}

const entryOf = (program: string, episode: string) => {
  const ep = st.programs.find(p => p.name === program)?.episodes.find(e => e.episode === episode)
  return st.entries.find(e => e.ep === ep) ?? null
}

async function play(entry: Entry) {
  if (st.current && episodeKey(st.current.ep) === episodeKey(entry.ep) && audioUrl) {
    if (audio.paused) void audio.play(); else audio.pause()
    return
  }
  saveProgress()
  audio.pause()
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = '' }
  st.current = entry; st.audioLoading = 0; st.follow = true; render()
  try {
    const url = await source.audio(entry, f => { st.audioLoading = f; updateLive() })
    if (st.current !== entry) { URL.revokeObjectURL(url); return } // 読み込み中に別の回を選んだ
    audioUrl = url
    audio.src = url
    audio.playbackRate = speed
    const pos = progress[episodeKey(entry.ep)]?.pos ?? 0
    audio.addEventListener('loadedmetadata', () => { if (pos > 0 && pos < audio.duration - 1) audio.currentTime = pos }, { once: true })
    st.audioLoading = -1
    setMediaSession(entry)
    await audio.play().catch(() => { /* 自動で鳴らせないときは再生ボタンを押してもらう */ })
  } catch (e) {
    if (e instanceof AuthError) { st.screen = 'login'; st.error = e.message; st.current = null }
    else st.error = e instanceof Error ? e.message : String(e)
    st.audioLoading = -1
  }
  render()
}

function saveProgress() {
  const c = st.current
  if (!c || !audioUrl) return
  const dur = audio.duration || c.ep.duration
  progress[episodeKey(c.ep)] = updateProgress(progress[episodeKey(c.ep)], audio.currentTime, dur)
  store.set('listen.progress', progress)
}

function seek(t: number) {
  if (!audioUrl) return
  audio.currentTime = Math.max(0, Math.min(t, (audio.duration || 0) - 0.1))
  updateLive()
}

function setMediaSession(e: Entry) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({ title: e.ep.date, artist: e.ep.program, album: e.ep.members.join('・') })
  const ms = navigator.mediaSession
  ms.setActionHandler('play', () => void audio.play())
  ms.setActionHandler('pause', () => audio.pause())
  ms.setActionHandler('seekbackward', () => seek(audio.currentTime - 15))
  ms.setActionHandler('seekforward', () => seek(audio.currentTime + 15))
  try { ms.setActionHandler('seekto', d => d.seekTime != null && seek(d.seekTime)) } catch { /* 古い端末 */ }
}

// ---------------------------------------------------------------- 画面

const app = document.getElementById('app')!

function render() {
  const scrollY = st.screen === 'player' ? null : window.scrollY
  app.replaceChildren(st.screen === 'login' ? loginView() : st.screen === 'player' && st.current ? playerView(st.current) : listView())
  if (scrollY != null) window.scrollTo(0, scrollY)
  updateLive(true)
}

function loginView() {
  const ready = !!CLIENT_ID
  return h('main', { class: 'screen login' },
    h('div', { class: 'loginhead' },
      h('div', { class: 'appicon' }, svg(I.phones, 38)),
      h('h1', {}, '完成版を', h('br'), 'どこでも聴く'),
      h('p', { class: 'sub' }, '編集アプリで書き出した回が、Google Drive の「完成版」フォルダから届きます。Mac が閉じていても聴けます。')),
    h('div', { class: 'loginfoot' },
      h('button', {
        type: 'button', class: 'primary', disabled: !ready || st.signingIn,
        onClick: () => { st.signingIn = true; st.error = ''; render(); auth.signIn(CLIENT_ID) },
      }, svg(I.google, 20), st.signingIn ? 'ログイン中…' : 'Google でログイン'),
      st.error && h('p', { class: 'err', role: 'alert' }, st.error),
      !ready && h('p', { class: 'err' }, 'Google の設定（クライアント ID）がまだです。設定の手順は listen/README.md にあります'),
      h('p', { class: 'note' }, '読むのは完成版のファイル（.listen.json と MP3）だけです。', h('br'), 'ファイルを書き換えたり消したりはしません。')))
}

function listView() {
  const p = prog()
  const head = h('header', { class: 'listhead' },
    h('div', { class: 'toprow' },
      h('span', { class: 'sub' }, DEMO ? '試聴（お試しデータ）' : '試聴'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': '読み込み直す', onClick: () => void loadList() }, svg(I.refresh)),
        !DEMO && h('button', {
          type: 'button', class: 'iconbtn', 'aria-label': 'ログアウト',
          onClick: () => { if (confirm('ログアウトしますか？')) { audio.pause(); auth.signOut(); st.screen = 'login'; render() } },
        }, svg(I.user)))),
    st.programs.length > 1 && h('nav', { class: 'progtabs', 'aria-label': '番組' },
      ...st.programs.map((x, i) => h('button', { type: 'button', class: i === st.prog ? 'on' : '', onClick: () => { st.prog = i; render() } }, x.name))),
    p && h('div', { class: 'proghead' },
      tile(p.name, 'tile big'),
      h('div', { class: 'progtext' },
        h('h1', {}, p.name),
        p.members.length > 0 && h('span', { class: 'sub' }, p.members.join('・')),
        h('span', { class: 'sub small' }, `${p.episodes.length} 回`))))

  let body: Node
  if (st.loading && !st.programs.length) body = h('p', { class: 'empty' }, '読み込んでいます…')
  else if (!p) body = h('div', { class: 'empty' },
    h('b', {}, 'まだ完成版がありません'),
    h('p', {}, '編集アプリの番組の設定で「完成版のコピー先フォルダ」に Google Drive のフォルダを選んでから、書き出してください。'))
  else body = h('section', { class: 'eplist' },
    h('span', { class: 'sub small pad' }, '新しい順'),
    ...p.episodes.map(ep => {
      const key = episodeKey(ep), isCur = st.current ? episodeKey(st.current.ep) === key : false
      const badge = episodeBadge(progress[key], isCur)
      const info = badge === 'playing' ? h('span', { class: 'accent small', 'data-live': 'cardtime' }, '')
        : h('span', { class: 'sub small' }, [fmtTime(ep.duration), badge === 'done' ? '聴いた' : badge === 'partial' ? `途中（${fmtTime(progress[key].pos)}）` : '新しい'].join('・'))
      return h('button', {
        type: 'button', class: `epcard${isCur ? ' on' : ''}`,
        onClick: () => { const e = entryOf(ep.program, ep.episode); if (e) { st.screen = 'player'; render(); void play(e) } },
      },
        h('span', { class: `epplay${isCur ? ' on' : ''}`, 'data-live': isCur ? 'cardicon' : null }, svg(isCur && !audio.paused ? I.pause : I.play, 18, true)),
        h('span', { class: 'eptext' }, h('b', {}, ep.date), info),
        badge === 'new' && h('span', { class: 'dot', 'aria-label': 'まだ聴いていない' }))
    }))

  return h('main', { class: 'screen list' }, head,
    st.error && h('p', { class: 'err card', role: 'alert' }, st.error),
    body,
    st.current && miniPlayer(st.current))
}

function miniPlayer(e: Entry) {
  return h('div', { class: 'mini' },
    h('button', { type: 'button', class: 'minimain', 'aria-label': '再生画面を開く', onClick: () => { st.screen = 'player'; render() } },
      tile(e.ep.program, 'tile small'),
      h('span', { class: 'eptext' }, h('b', {}, e.ep.date), h('span', { class: 'sub small' }, e.ep.program))),
    h('button', { type: 'button', class: 'miniplay', 'aria-label': '再生・一時停止', 'data-live': 'playbtn', onClick: () => void play(e) }, svg(I.play, 16, true)),
    h('div', { class: 'minibar' }, h('div', { 'data-live': 'bar' })))
}

function playerView(e: Entry) {
  const ep = e.ep
  const lines = h('div', { class: 'lines', 'data-live': 'lines' },
    ...ep.lines.map((l, i) => h('button', {
      type: 'button', class: 'line', 'data-i': String(i),
      onClick: () => { st.follow = true; seek(l.start); if (audio.paused) void audio.play() },
    },
      h('span', { class: 'lt' }, fmtTime(l.start)),
      h('span', { class: 'lb' },
        h('span', { class: 'ls', style: { color: ep.speakers[l.speaker] ?? 'var(--accent-text)' } }, l.speaker),
        h('span', { class: 'lx' }, l.text)))))
  // 指で動かしたら、今の文に合わせるのをやめる（右端のボタンで戻す）
  const stopFollow = () => { if (st.follow) { st.follow = false; updateLive(true) } }
  lines.addEventListener('touchmove', stopFollow, { passive: true })
  lines.addEventListener('wheel', stopFollow, { passive: true })

  const range = h('input', {
    type: 'range', class: 'seek', min: '0', max: String(ep.duration || 1), step: '0.1', value: '0', 'aria-label': '再生位置', 'data-live': 'seek',
    onInput: (ev: Event) => seek(Number((ev.target as HTMLInputElement).value)),
  })

  return h('main', { class: 'screen player' },
    h('div', { class: 'toprow' },
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': '一覧へ戻る', onClick: () => { st.screen = 'list'; render() } }, svg(I.back)),
      h('span', { class: 'sub center' }, ep.program),
      h('span', { class: 'iconspace' })),
    h('div', { class: 'phead' },
      tile(ep.program, 'tile mid'),
      h('div', {}, h('h1', {}, ep.date), h('span', { class: 'sub' }, [...ep.members, fmtTime(ep.duration)].join('・')))),
    h('div', { class: 'seekbox' }, range,
      h('div', { class: 'times' }, h('span', { 'data-live': 'pos' }, '0:00'), h('span', { 'data-live': 'rest' }, ''))),
    h('div', { class: 'controls' },
      h('button', {
        type: 'button', class: 'chipbtn', 'aria-label': '再生速度', 'data-live': 'speed',
        onClick: () => { speed = nextSpeed(speed); audio.playbackRate = speed; store.set('listen.speed', speed); updateLive() },
      }, speedText(speed)),
      h('button', { type: 'button', class: 'skip', 'aria-label': '15秒戻る', onClick: () => seek(audio.currentTime - 15) }, svg(I.rew, 30)),
      h('button', { type: 'button', class: 'bigplay', 'aria-label': '再生・一時停止', 'data-live': 'playbtn', onClick: () => void play(e) }, svg(I.play, 28, true)),
      h('button', { type: 'button', class: 'skip', 'aria-label': '15秒進む', onClick: () => seek(audio.currentTime + 15) }, svg(I.fwd, 30)),
      h('button', {
        type: 'button', class: 'chipbtn', 'aria-label': '今の文へ戻る', 'data-live': 'followbtn',
        onClick: () => { st.follow = true; updateLive(true) },
      }, svg(I.lines))),
    st.error && h('p', { class: 'err card', role: 'alert' }, st.error),
    h('section', { class: 'transcript' },
      h('span', { class: 'sub small pad' }, ep.lines.length ? '文字起こし（押すとそこから再生）' : '文字起こしはありません'),
      lines))
}

// ---------------------------------------------------------------- 再生中に変わる所だけ書き換える

let lastLine = -2
function updateLive(force = false) {
  const $ = (k: string) => app.querySelectorAll<HTMLElement>(`[data-live="${k}"]`)
  const c = st.current
  const dur = audio.duration || c?.ep.duration || 0
  const t = audio.currentTime || (c ? progress[episodeKey(c.ep)]?.pos ?? 0 : 0)
  const loading = st.audioLoading >= 0
  for (const b of $('playbtn')) {
    b.replaceChildren(loading ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : svg(audio.paused ? I.play : I.pause, b.classList.contains('bigplay') ? 28 : 16, true))
    b.setAttribute('aria-label', loading ? '読み込み中' : audio.paused ? '再生' : '一時停止')
  }
  for (const b of $('cardicon')) b.replaceChildren(svg(audio.paused ? I.play : I.pause, 18, true))
  const timeText = loading ? `読み込み中 ${Math.round(st.audioLoading * 100)}%` : `${audio.paused ? '一時停止' : '再生中'} ${fmtTime(t)} / ${fmtTime(dur)}`
  for (const s of $('cardtime')) s.textContent = timeText
  for (const b of $('bar')) b.style.width = loading ? `${st.audioLoading * 100}%` : `${dur ? (t / dur) * 100 : 0}%`
  for (const r of $('seek') as NodeListOf<HTMLInputElement>) {
    if (document.activeElement !== r) r.value = String(t)
    r.max = String(dur || 1)
    r.style.setProperty('--p', `${dur ? (t / dur) * 100 : 0}%`)
    r.disabled = loading || !audioUrl
  }
  for (const s of $('pos')) s.textContent = loading ? `読み込み中 ${Math.round(st.audioLoading * 100)}%` : fmtTime(t)
  for (const s of $('rest')) s.textContent = `−${fmtTime(Math.max(0, dur - t))}`
  for (const s of $('speed')) s.textContent = speedText(speed)
  for (const b of $('followbtn')) b.classList.toggle('on', !st.follow)
  const box = $('lines')[0]
  if (box && c) {
    const i = lineAt(c.ep.lines, t + 0.05)
    if (i !== lastLine || force) {
      box.querySelector('.line.now')?.classList.remove('now')
      const el = i >= 0 ? box.querySelector<HTMLElement>(`.line[data-i="${i}"]`) : null
      el?.classList.add('now')
      if (el && st.follow) {
        const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2
        box.scrollTo({ top, behavior: force ? 'auto' : 'smooth' })
      }
      lastLine = i
    }
  }
}

let lastSave = 0
audio.addEventListener('timeupdate', () => {
  updateLive()
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveProgress() }
})
for (const ev of ['play', 'pause', 'ended', 'loadedmetadata', 'ratechange']) audio.addEventListener(ev, () => { if (ev !== 'play') saveProgress(); updateLive() })
audio.addEventListener('ended', () => render())
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress() })
window.addEventListener('pagehide', saveProgress)

// ---------------------------------------------------------------- 始める

// Safari の「戻る」でログイン画面から戻ったとき、「ログイン中…」のままにしない
window.addEventListener('pageshow', e => { if (e.persisted && st.signingIn) { st.signingIn = false; render() } })
render()
if (st.screen === 'list') void loadList()
