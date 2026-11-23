# podcast-editor

複数話者のPodcast音声を、Claudeでほぼ自動編集しつつ、手元のUIで微調整できる編集ツール（開発中）。

- 計画：[docs/PLAN.md](docs/PLAN.md)
- `engine/`：音声処理エンジン（Python）
- `ui/`：編集画面（React + TypeScript）

音声データはこのリポジトリに入れず、Mac内の別フォルダ（例：`~/Podcast/`）に置きます。

## 編集アプリを開く（Claude を使わずに）

最初に一度だけ、ターミナルで次を実行すると `~/Applications/ポッドキャスト編集.app` ができます。

```bash
scripts/make-mac-app.sh
```

あとは Finder の「アプリケーション」（ホームの中）や Spotlight で「ポッドキャスト編集」を開くだけです。Dock に入れておくと 1 クリックで開けます。

- サーバーが動いていなければ裏で起動し、Chrome のアプリ窓（なければ既定のブラウザ）で番組一覧を開きます
- 画面のソースが変わっていれば、開く前に作り直します
- 記録は `~/Library/Logs/podcast-editor.log`。サーバーはログアウトまで裏で動き続けます
