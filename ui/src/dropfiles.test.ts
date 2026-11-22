import { describe, expect, it } from 'vitest'
import { guessDate } from './dropfiles'

describe('guessDate', () => {
  it('フォルダ名やファイル名から日付を見つける', () => {
    expect(guessDate(['20261204'])).toBe('20261204')
    expect(guessDate([null, '20261204_1.wav'])).toBe('20261204')
    expect(guessDate(['2026_09_25_1.wav'])).toBe('20260925')
    expect(guessDate(['収録 2026-12-11'])).toBe('20261211')
  })
  it('ありえない日付や数字のないものは null', () => {
    expect(guessDate(['20261399'])).toBeNull()
    expect(guessDate(['素材', 'aoki.wav'])).toBeNull()
  })
})
