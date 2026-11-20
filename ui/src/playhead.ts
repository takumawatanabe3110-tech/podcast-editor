// 再生位置を画面に伝える。再生中は毎フレーム知らせるが、
// selector の結果が変わったときだけ部品を描き直す（台本の行の切り替わりなど）。
import { useCallback, useSyncExternalStore } from 'react'
import type { Player } from './player'

export function usePlayhead<T>(player: Player, selector: (outT: number, playing: boolean) => T): T {
  // subscribe は描き直しのたびに作り直さない（作り直すと付け直しの間に毎フレームのループが止まる）
  const subscribe = useCallback((cb: () => void) => {
    let raf = 0
    const loop = () => { cb(); raf = player.playing ? requestAnimationFrame(loop) : 0 }
    const off = player.on(() => { cancelAnimationFrame(raf); loop() })
    if (player.playing) raf = requestAnimationFrame(loop) // 再生中に付けられたときもループを始める
    return () => { off(); cancelAnimationFrame(raf) }
  }, [player])
  return useSyncExternalStore(subscribe, () => selector(player.position(), player.playing))
}
