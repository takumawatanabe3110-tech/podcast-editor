import { describe, expect, it } from 'vitest'
import { episodeBadge, fmtTime, groupPrograms, lineAt, nextSpeed, parseEpisode, updateProgress, type ListenEpisode } from './logic'

const ep = (over: Partial<ListenEpisode> = {}): ListenEpisode => ({
  format: 'podlisten', version: 1, program: '岡田山ラジオ', episode: '20261204', date: '2026-12-04',
  members: ['青木さん', '内田さん'], speakers: {}, duration: 1359.6, audio: 'a.mp3', exported_at: '2026-12-05T00:00:00Z',
  lines: [], ...over,
})

describe('parseEpisode', () => {
  it('正しい形を読む（文は時刻順に並べる）', () => {
    const e = parseEpisode({ ...ep(), lines: [{ speaker: 'b', text: 'y', start: 5, end: 6 }, { speaker: 'a', text: 'x', start: 1, end: 2 }] })!
    expect(e.lines.map(l => l.text)).toEqual(['x', 'y'])
    expect(e.date).toBe('2026-12-04')
  })
  it('ほかのファイルは null', () => {
    expect(parseEpisode(null)).toBeNull()
    expect(parseEpisode({ format: 'podproj' })).toBeNull()
    expect(parseEpisode({ ...ep(), episode: '12/4' })).toBeNull()
  })
  it('壊れた文は捨てる・足りない値は補う', () => {
    const e = parseEpisode({ format: 'podlisten', program: 'p', episode: '20260102', audio: 'x.mp3', lines: [{ text: 'a' }, { text: 'b', start: 0, end: 1 }] })!
    expect(e.lines).toHaveLength(1)
    expect(e).toMatchObject({ date: '2026-01-02', members: [], duration: 0 })
  })
})

describe('groupPrograms', () => {
  it('番組ごと・新しい順。同じ回は書き出しの新しい方', () => {
    const ps = groupPrograms([
      ep({ episode: '20261204' }),
      ep({ episode: '20261211', exported_at: '1' }),
      ep({ episode: '20261211', exported_at: '2', audio: 'new.mp3' }),
      ep({ program: '別番組', episode: '20261101', members: [] , lines: [{ speaker: 'X', text: 't', start: 0, end: 1 }] }),
    ])
    expect(ps.map(p => p.name)).toEqual(['岡田山ラジオ', '別番組'])
    expect(ps[0].episodes.map(e => e.episode)).toEqual(['20261211', '20261204'])
    expect(ps[0].episodes[0].audio).toBe('new.mp3')
    expect(ps[1].members).toEqual(['X'])
  })
})

describe('lineAt', () => {
  const lines = [0, 5, 9].map(s => ({ speaker: '', text: '', start: s, end: s + 3 }))
  it('今の文（間なら直前）', () => {
    expect(lineAt(lines, -1)).toBe(-1)
    expect(lineAt(lines, 0)).toBe(0)
    expect(lineAt(lines, 4)).toBe(0)
    expect(lineAt(lines, 5)).toBe(1)
    expect(lineAt(lines, 100)).toBe(2)
    expect(lineAt([], 3)).toBe(-1)
  })
})

describe('小物', () => {
  it('fmtTime', () => {
    expect(fmtTime(88)).toBe('1:28')
    expect(fmtTime(1359.6)).toBe('22:39')
    expect(fmtTime(3723)).toBe('1:02:03')
    expect(fmtTime(NaN)).toBe('0:00')
  })
  it('nextSpeed は一周する', () => {
    expect(nextSpeed(1)).toBe(1.25)
    expect(nextSpeed(0.75)).toBe(1)
    expect(nextSpeed(3)).toBe(1)
  })
  it('聴いた位置：最後の30秒で「聴いた」、最後まで行ったら頭に戻す', () => {
    expect(updateProgress(undefined, 100, 1000)).toEqual({ pos: 100, done: false })
    expect(updateProgress(undefined, 980, 1000)).toEqual({ pos: 980, done: true })
    expect(updateProgress({ pos: 980, done: true }, 10, 1000)).toEqual({ pos: 10, done: true })
    expect(updateProgress(undefined, 999.5, 1000)).toEqual({ pos: 0, done: true })
  })
  it('一覧の札', () => {
    expect(episodeBadge(undefined, false)).toBe('new')
    expect(episodeBadge({ pos: 0, done: false }, true)).toBe('playing')
    expect(episodeBadge({ pos: 50, done: false }, false)).toBe('partial')
    expect(episodeBadge({ pos: 0, done: true }, false)).toBe('done')
  })
})
