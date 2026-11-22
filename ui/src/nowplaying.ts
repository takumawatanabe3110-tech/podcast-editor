// 「いま聴いている音」を、一覧画面と編集画面のあいだで1つにまとめる。
// - 編集画面の音（Player：編集中の状態をそのまま鳴らす）
// - 一覧画面の音（Mp3：書き出した MP3 を鳴らす）
// 画面を切り替えても止めず、どちらか一方だけが鳴るようにする。
import { useEffect, useState } from 'react'
import { episodeAudioUrl, type Current } from './library'
import type { Player } from './player'

type Listener = () => void

/** 書き出した MP3 を鳴らす。画面を切り替えても続くよう、部品の外に置く */
export class Mp3 {
  private a: HTMLAudioElement | null = null
  prog = ''
  ep = ''
  private dur = 0
  rate = 1
  vol = 1
  private listeners = new Set<Listener>()

  on(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private emit() { this.listeners.forEach(f => f()) }

  private ensure() {
    if (!this.a) {
      const a = new Audio()
      a.preload = 'metadata'
      for (const ev of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'ended']) a.addEventListener(ev, () => this.emit())
      this.a = a
    }
    return this.a
  }

  get active() { return !!this.ep }
  get playing() { return !!this.a && !this.a.paused }
  get time() { return this.a?.currentTime ?? 0 }
  get duration() { const d = this.a?.duration; return d != null && Number.isFinite(d) ? d : this.dur }

  load(prog: string, ep: string, dur: number, play: boolean, at = 0) {
    const a = this.ensure()
    if (this.prog !== prog || this.ep !== ep) {
      this.prog = prog; this.ep = ep; this.dur = dur
      a.src = episodeAudioUrl(prog, ep)
      a.currentTime = at
    } else if (at) a.currentTime = at
    a.playbackRate = this.rate; a.volume = this.vol
    if (play) void a.play().catch(() => {})
    this.emit()
  }
  play() { if (this.a) void this.a.play().catch(() => {}) }
  pause() { this.a?.pause() }
  seek(t: number) { const a = this.a; if (!a) return; a.currentTime = Math.max(0, Math.min(t, a.duration || t)); this.emit() }
  setRate(r: number) { this.rate = r; if (this.a) this.a.playbackRate = r; this.emit() }
  setVol(v: number) { this.vol = v; if (this.a) this.a.volume = v; this.emit() }
  /** 鳴らしていない状態に戻す（再生バーを消す） */
  clear() { this.a?.pause(); this.prog = ''; this.ep = ''; this.emit() }
}

export type Source = 'mp3' | 'edit' | null

/** 一覧画面が使う「いま聴いている音」。編集画面の音を鳴らしているときは、そちらを操作する */
export interface NowPlaying {
  st: { prog: string; ep: string; t: number; dur: number; playing: boolean } | null
  /** 編集画面の音（編集中の状態）を鳴らしているか。速度と音量は MP3 のときだけ変えられる */
  live: boolean
  rate: number
  vol: number
  /** この回を（MP3 がなくても）聴けるか */
  canPlay: (prog: string, ep: string, exported: boolean) => boolean
  load: (prog: string, ep: string, dur: number, play: boolean, at?: number) => void
  toggle: () => void
  seek: (t: number) => void
  skip: (d: number) => void
  changeRate: () => void
  changeVol: (v: number) => void
}

export interface NowPlayingDeps {
  mp3: Mp3
  edit: Player | null // 開いている回の音。読み込みが終わっていなければ null
  current: Current | null
  source: Source
  setSource: (s: Source) => void
}

export function useNowPlaying({ mp3, edit, current, source, setSource }: NowPlayingDeps): NowPlaying {
  const [, tick] = useState(0)
  useEffect(() => {
    const re = () => tick(n => n + 1)
    const offs = [mp3.on(re), edit?.on(re)]
    // 編集画面の音は再生中に知らせが来ないので、少しずつ様子を見る
    const id = window.setInterval(() => { if (source === 'edit' && edit?.playing) re() }, 250)
    return () => { offs.forEach(o => o?.()); window.clearInterval(id) }
  }, [mp3, edit, source])

  const isCurrent = (prog: string, ep: string) => !!edit && !!current && current.program === prog && current.episode === ep
  const live = source === 'edit' && !!edit && !!current

  const st: NowPlaying['st'] = live
    ? { prog: current!.program, ep: current!.episode, t: edit!.position(), dur: edit!.totalLength(), playing: edit!.playing }
    : source === 'mp3' && mp3.active ? { prog: mp3.prog, ep: mp3.ep, t: mp3.time, dur: mp3.duration, playing: mp3.playing }
      : null

  const load: NowPlaying['load'] = (prog, ep, dur, play, at = 0) => {
    if (isCurrent(prog, ep)) {
      // 開いている回は、編集中の状態のまま鳴らす（編集画面と同じ音・同じ位置）
      mp3.pause()
      if (at || source !== 'edit') edit!.seek(at)
      if (play) edit!.play()
      setSource('edit')
    } else {
      if (edit?.playing) edit.pause()
      mp3.load(prog, ep, dur, play, at)
      setSource('mp3')
    }
  }
  const seek = (t: number) => { if (live) edit!.seek(Math.max(0, Math.min(t, edit!.totalLength()))); else mp3.seek(t) }
  return {
    st, live, rate: mp3.rate, vol: mp3.vol,
    canPlay: (prog, ep, exported) => exported || isCurrent(prog, ep),
    load,
    toggle: () => { if (live) edit!.toggle(); else if (mp3.playing) mp3.pause(); else mp3.play() },
    seek,
    skip: d => seek((st?.t ?? 0) + d),
    changeRate: () => { const r = mp3.rate; mp3.setRate(r === 1 ? 1.25 : r === 1.25 ? 1.5 : r === 1.5 ? 2 : 1) },
    changeVol: v => mp3.setVol(v),
  }
}
