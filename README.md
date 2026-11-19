# podcast-editor

複数話者のPodcast音声を、Claudeでほぼ自動編集しつつ、手元のUIで微調整できる編集ツール（開発中）。

- 計画：[docs/PLAN.md](docs/PLAN.md)
- `engine/`：音声処理エンジン（Python）
- `ui/`：編集画面（React + TypeScript）

音声データはこのリポジトリに入れず、Mac内の別フォルダ（例：`~/Podcast/`）に置きます。
