# podcast-editor 開発メモ（Claude向け）

- 計画と要件は docs/PLAN.md。作業前に読み、決定事項が変わったら更新する
- 日本語で説明する。ユーザーは音声編集の経験者だがプログラミングの専門家ではない前提で、専門用語は短く補足する
- ユーザーへの質問・選択肢の提示は、ask-form Mod（mcp__ask-form__ask）が使えればそれを使う。タブが表示されないと返ってきたらチャットで番号付きで聞く
  - Mod：https://github.com/takumawatanabe3110-tech/claude-mods
- 音声ファイル（wav/mp3/flac等）はコミットしない。テスト用の短い合成音声は生成スクリプトで作る
- ルール：Claudeは音声を直接扱わず、解析結果と文字起こしから編集指示（JSON）を出す。編集は非破壊（.podproj）
