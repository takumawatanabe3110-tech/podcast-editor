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

## テスト

```bash
cd engine
../.venv/bin/python -m pytest -q
```

テスト用の音声は `podcast_engine/synth.py` で合成する（実際の録音はリポジトリに入れない）。
