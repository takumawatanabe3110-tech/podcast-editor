import { describe, expect, it } from 'vitest'
import { episodeKicker, progressLabel, type Episode } from './library'

describe('回のカードの表示', () => {
  const base: Episode = { id: '20991201' }
  it('処理中は見出しに段階を重ねず、バーの下に段階と % を出す', () => {
    const ep: Episode = { ...base, job: { state: 'running', stage: 'voice2：文字起こし中…', progress: 0.75 } }
    expect(episodeKicker(ep, false)).toBe('処理中')
    expect(progressLabel(ep.job!)).toBe('voice2：文字起こし中… ・ 75%')
  })
  it('段階がまだ来ていなければ「処理中」', () => {
    expect(progressLabel({ state: 'running', stage: '', progress: 0.1 })).toBe('処理中 ・ 10%')
    expect(progressLabel({ state: 'running' })).toBe('処理中 ・ 0%')
  })
  it('順番待ち・書き出し済み・編集中', () => {
    expect(episodeKicker({ ...base, job: { state: 'queued', position: 1 } }, false)).toBe('順番待ち')
    const ex: Episode = { ...base, has_project: true, exported: { path: 'x.mp3', size: 1, mtime: 0 } }
    expect(episodeKicker(ex, true)).toBe('編集中 ・ MP3 書き出し済み')
    expect(episodeKicker(ex, false)).toBe('MP3 書き出し済み')
    expect(episodeKicker({ ...base, has_project: true }, false)).toBe('まだ書き出していません')
    expect(episodeKicker(base, false)).toBe('素材のみ')
  })
})
