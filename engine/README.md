音声処理エンジン（Python）。

## 準備

リポジトリ直下で仮想環境を作り、ライブラリを入れる。

```bash
python3 -m venv .venv
.venv/bin/pip install -U pip   # Mac標準のpipは古く、次の行が失敗するため
.venv/bin/pip install -e "engine[dev]"
```

## 使い方

```bash
cd engine
../.venv/bin/python -m podcast_engine info  素材1.wav 素材2.wav
../.venv/bin/python -m podcast_engine sync  素材1.wav 素材2.wav --out sync.json
```

`sync` は1本目を基準に、各トラックのずれ（秒）とドリフト（ppm）を JSON で出す。

### プロジェクトを作って書き出す

```bash
../.venv/bin/python -m podcast_engine init 素材1.wav 素材2.wav --out 回.podproj --names 青木さん 内田さん
../.venv/bin/python -m podcast_engine cut 回.podproj 1:23.5 1:30      # 基準時刻でカット
../.venv/bin/python -m podcast_engine cut 回.podproj 5:00 5:10 --output-time  # 完成版の時刻でカット
../.venv/bin/python -m podcast_engine render 回.podproj --out 回.mp3
```

`.podproj` は JSON。音量・BGM などは直接書き換える（形式は `podcast_engine/project.py`）。
元の音声は書き換えない（非破壊）。

## テスト

```bash
cd engine
../.venv/bin/python -m pytest -q
```

テスト用の音声は `podcast_engine/synth.py` で合成する（実際の録音はリポジトリに入れない）。
