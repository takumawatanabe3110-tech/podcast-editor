# 編集画面（ui）

回の編集をブラウザで行う画面。React＋TypeScript で書いている。
台本・波形・再生・カット・文字の修正ができる。音声の処理そのものは `engine/` が行う。

## 使い方

```bash
cd ui
npm install        # 初回だけ
npm run build      # ui/dist を作る。サーバー（serve）はこれを配る
npm run dev        # 開発中のみ：Vite の 5173 番で画面を開く
npx vitest run     # テスト
```

- 普段は `npm run build` の後、`engine` から `python -m podcast_engine serve 回.podproj` を動かす。
- `npm run dev` は画面を自動で更新しながら直せる。ただし `/api` の通信は 8765 番のサーバーへ中継するので、先に `serve` を動かしておく。

## ファイルの役割

- `src/App.tsx`：全体。読み込み・保存・キー操作（Space、⌘Z など）
- `src/ScriptPanel.tsx`：台本（行のクリック・選んでカット・文字の修正）
- `src/TrackView.tsx`：全体バー・波形・ルビ・BGM の音量カーブ
- `src/player.ts`：Web Audio による再生（カット・音量・パン・BGM。トラックの音量をその場で変える・メーター・ソロ・範囲の試聴）
- `src/Mixer.tsx`：ミキサー・書き出しの結果
- `src/layout.tsx`：欄の広さ（境目のドラッグ・台本の開け閉め）。ブラウザに覚えさせる
- `src/BgmView.tsx`：②BGM 画面
- `src/bgmops.ts`：BGM の点・始まり・切る位置・フェードの計算
- `src/EffectsView.tsx`：エフェクト画面（一覧・EQ・コンプ・ゲート・ノイズ除去・マスター）
- `src/presetctx.ts`：いつもの設定を画面で共有する入れ物と、EQ のひな形の一覧
- `src/fxchain.ts`：トラックのエフェクトを Web Audio の部品で組み立てる
- `src/dsp.ts`：EQ のカーブ・コンプ／ゲートの関係の計算。エンジンと同じ式
- `src/dynamicsCore.ts`・`src/dynamics.worklet.ts`：再生中のコンプ・ゲート。エンジンと同じ計算
- `src/__fixtures__/`：エンジンから作った基準の値。`make_reference.py` で作り直す
- `src/timeline.ts`：時刻の計算。エンジンの `project.py`／`render.py` と同じ結果になるようにしている
- `src/editops.ts`：台本からのカットと、カットの取り消し（復元）
- `src/types.ts`：.podproj と文字起こし（.transcript.json）の形
- `src/api.ts`：サーバーとの通信（/api/...）

注意：`Timeline` という名前のファイルは作らないこと。Mac はファイル名の大文字と小文字を区別しないため、`timeline.ts` とぶつかる。
