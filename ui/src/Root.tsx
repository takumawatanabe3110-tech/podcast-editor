// 入口：開いている回があれば編集画面、なければ一覧画面。
// 回を開き直すときは、音や波形を読み込み直すため、ページごと読み込み直す（いちばん確実）。
import { useEffect, useState } from 'react'
import App from './App'
import { LibraryView } from './LibraryView'
import { getCurrent, type Current } from './library'

export default function Root() {
  const [current, setCurrent] = useState<Current | null | undefined>(undefined)
  const [showList, setShowList] = useState(false)
  useEffect(() => {
    // 一覧の仕組みがない古いサーバー（serve で1つのプロジェクトだけ開く）では、そのまま編集画面にする
    getCurrent().then(c => setCurrent(c ?? null), () => setCurrent({ program: '', episode: '' }))
  }, [])
  if (current === undefined) return <div className="center">読み込み中…</div>
  if (!current || showList) return <LibraryView current={current} onOpened={() => window.location.reload()} />
  return <App current={current} onShowList={() => setShowList(true)} />
}
