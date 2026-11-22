// 入口：開いている回があれば編集画面、なければ一覧画面。
// 画面を切り替えても音を止めないよう、編集画面は一覧を見ているあいだも裏で開いたままにし、
// 「いま聴いている音」（編集画面の音／一覧の MP3）をここでまとめて持つ。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import App from './App'
import { LibraryView } from './LibraryView'
import { getCurrent, openEpisode, type Current } from './library'
import { Mp3, type Source } from './nowplaying'
import { Player } from './player'

export default function Root() {
  const [current, setCurrent] = useState<Current | null | undefined>(undefined)
  const [showList, setShowList] = useState(false)
  const [ready, setReady] = useState(false) // 編集画面の音を読み込み終えたか
  const [source, setSource] = useState<Source>(null)
  const mp3 = useMemo(() => new Mp3(), [])
  const handoff = useRef(false) // 編集画面の読み込みが終わったら、MP3 の続きを編集画面の音で鳴らす

  useEffect(() => {
    // 一覧の仕組みがない古いサーバー（serve で1つのプロジェクトだけ開く）では、そのまま編集画面にする
    getCurrent().then(c => setCurrent(c ?? null), () => setCurrent({ program: '', episode: '' }))
  }, [])

  const key = current ? `${current.program}/${current.episode}` : ''
  // 回ごとに1つの Player。別の回を開いたら前のものは片付ける
  const player = useMemo(() => (key ? new Player() : null), [key])
  const prevPlayer = useRef<Player | null>(null)
  useEffect(() => {
    if (prevPlayer.current && prevPlayer.current !== player) prevPlayer.current.dispose()
    prevPlayer.current = player
  }, [player])

  /** MP3 で聴いていた位置から、編集画面の音で続けて鳴らす */
  const takeOver = useCallback(() => {
    if (!player || !current) return
    handoff.current = false
    if (mp3.prog === current.program && mp3.ep === current.episode && mp3.playing) {
      player.seek(mp3.time)
      player.play()
      mp3.clear()
      setSource('edit')
    }
  }, [player, current, mp3])

  const onReady = useCallback(() => {
    setReady(true)
    if (handoff.current) takeOver()
  }, [takeOver])

  /** 一覧から編集画面へ。開いている回ならそのまま戻り、聴いていた音を引き継ぐ */
  const toEdit = useCallback(async (program: string, episode: string) => {
    const same = current?.program === program && current.episode === episode
    if (!same) {
      await openEpisode(program, episode)
      setReady(false)
      setCurrent({ program, episode })
    }
    // 別の回の MP3 は止める（編集画面では開いた回だけを鳴らす）
    if (mp3.playing && !(mp3.prog === program && mp3.ep === episode)) mp3.clear()
    if (mp3.playing) {
      if (same && ready) takeOver()
      else handoff.current = true // 読み込みが終わるまで MP3 のまま鳴らしておく
    } else if (source === 'mp3') mp3.clear()
    setShowList(false)
  }, [current, mp3, ready, source, takeOver])

  const toList = useCallback(() => {
    if (player?.playing) setSource('edit')
    setShowList(true)
  }, [player])

  if (current === undefined) return <div className="center">読み込み中…</div>
  const list = !current || showList
  return (
    <>
      {list && (
        <LibraryView current={current} onOpen={toEdit}
          now={{ mp3, edit: ready ? player : null, current, source, setSource }} />
      )}
      {current && player && (
        <div style={{ display: list ? 'none' : 'contents' }}>
          <App key={key} current={current} player={player} active={!list} onReady={onReady} onShowList={toList} />
        </div>
      )}
    </>
  )
}
