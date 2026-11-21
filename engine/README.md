音声処理エンジン（Python）。

## 準備

リポジトリ直下で仮想環境を作り、ライブラリを入れる。

```bash
python3 -m venv .venv
.venv/bin/pip install -U pip   # Mac標準のpipは古く、次の行が失敗するため
.venv/bin/pip install -e "engine[dev,denoise,transcribe]"   # denoise＝ノイズ除去（PyTorch）、transcribe＝文字起こし（mlx-whisper）
# 初回の文字起こしで Whisper large-v3-turbo（約1.6GB）を自動ダウンロードする
```

任意の追加（使うときだけ入れる）：
- `voiceprint`：声紋で話者の名前を判定する（resemblyzer など。torch は denoise と同じ 2.0.1）
- `server`：編集画面のサーバー（fastapi・uvicorn・python-multipart）。`serve` を使うときに必要

```bash
.venv/bin/pip install -e "engine[server,voiceprint]"
```

## 使い方

```bash
cd engine
../.venv/bin/python -m podcast_engine info  素材1.wav 素材2.wav
../.venv/bin/python -m podcast_engine sync  素材1.wav 素材2.wav --out sync.json
```

`sync` は1本目を基準に、各トラックのずれ（秒）とドリフト（ppm）を JSON で出す。

### いつもの設定で1本仕上げる（トークン不要）

```bash
../.venv/bin/python -m podcast_engine init 青木.wav 内田.wav --preset okadayama --out 回.podproj
../.venv/bin/python -m podcast_engine transcribe 回.podproj   # 文字起こし（21分で約6分）。話の終わりも自動で切る
../.venv/bin/python -m podcast_engine render 回.podproj --out 回.mp3
```

`transcribe` は `回.transcript.txt`（台本：話者・時刻・フィラー抜きの文）と
`回.transcript.json`（ルビ用：1文字ごとの時刻、フィラーの印つき）を作る。

`--preset okadayama` で `presets/okadayama.json` の設定（声の音量の自動調整、EQ、フェーダー、コンプ、ノイズ除去、
OP/ED の BGM の置き方、−14 LUFS）がまとめて入る。素材は「青木さん、内田さん、（ゲスト）」の順に並べる。
話の終わりは、`transcribe` が最後の言葉の 1.3 秒後で切る（ED の BGM もついてくる）。

プロジェクトには使ったプリセットの名前（`preset`）が残る。編集画面から EQ のひな形を呼び出したり、トラックのエフェクトや BGM の置き方を「いつもの設定」に保存したりできる（`presets/` のファイルが書き換わる）。

### 編集画面を開く

```bash
cd ui && npm install && npm run build && cd ..   # 初回と、画面を直したとき
cd engine
../.venv/bin/python -m podcast_engine serve 回.podproj   # ブラウザで http://127.0.0.1:8765/ が開く（止めるときは Ctrl+C）
```

台本・波形・再生・カット・文字の修正ができる。ミキサー（フェーダー・メーター）、BGM の編集、エフェクト画面（EQ・コンプ・ゲート・ノイズ除去を再生しながら調整）、「書き出し（MP3）」ボタン（`render` コマンドと同じ結果）もある。変更はその場で .podproj と .transcript.json に保存される。
初回は波形と試聴用の音を作るので少し待つ（.podcache/ に保存）。

### 番組と回の一覧で使う

```bash
cd engine
../.venv/bin/python -m podcast_engine serve   # 一覧から回を選んで開く（引数なし）
../.venv/bin/python -m podcast_engine library-init   # 番組フォルダ（program.json）を作る。既定は岡田山ラジオ
../.venv/bin/python -m podcast_engine init --program ../岡田山ラジオ 青木.wav 内田.wav --out 回.podproj
```

- `serve` を引数なしで動かすと、番組と回の一覧から選ぶ画面になる。
- `library-init` は番組フォルダを作る（BGM はプリセットから `BGM/` にコピーされる）。
- `init --program` は番組の BGM・声紋・いつもの設定を使う。声紋があれば話者に名前が付く（`_1`・`_2` の順に頼らない）。

### プロジェクトを作って書き出す

```bash
../.venv/bin/python -m podcast_engine init 素材1.wav 素材2.wav --out 回.podproj --names 青木さん 内田さん
../.venv/bin/python -m podcast_engine cut 回.podproj 1:23.5 1:30      # 基準時刻でカット
../.venv/bin/python -m podcast_engine cut 回.podproj 5:00 5:10 --output-time  # 完成版の時刻でカット
../.venv/bin/python -m podcast_engine render 回.podproj --out 回.mp3
```

`.podproj` は JSON。音量・BGM などは直接書き換える（形式は `podcast_engine/project.py`）。
EQ・コンプは `voices[].effects`／`bgm_effects`／`master_effects` に書く（書き方は `podcast_engine/effects.py` の先頭）。ノイズゲート（`gate`）も使える。
元の音声は書き換えない（非破壊）。
ノイズ除去の結果は `.podproj` と同じフォルダの `.podcache/` に保存される（1トラック数百MB。消しても次の書き出しで作り直す）。

## テスト

```bash
cd engine
../.venv/bin/python -m pytest -q
```

編集画面（ui）のテストは、`ui` フォルダで実行する：`cd ui && npx vitest run`

テスト用の音声は `podcast_engine/synth.py` で合成する（実際の録音はリポジトリに入れない）。
