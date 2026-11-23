# 試聴ページ（スマホ用）

編集アプリで書き出した完成版を、iPhone などで聴くためのページです。Mac が閉じていても聴けます。

- 書き出しのたびに、エンジンが番組の「完成版のコピー先フォルダ」へ `番組_YYYY-MM-DD.mp3` と `番組_YYYY-MM-DD.listen.json`（長さ・話者・文字起こし）を置きます
- そのフォルダを Google Drive（パソコン版）の中にしておくと、Google Drive に上がります
- このページは Google でログインして Drive の `.listen.json` を探し、回の一覧・再生・文字起こしを出します
- 聴いた位置・「聴いた」の印・再生速度は、その端末のブラウザにだけ残ります

## 手元で試す

```bash
cd listen
npm install
npm run dev        # http://localhost:5175/?demo
```

`?demo` を付けると、Google の代わりに `public/demo/` を読みます（`index.json` に `.listen.json` のファイル名を並べる）。`public/demo/` は Git に入れません。

```bash
npm test           # 計算のテスト
npm run build      # dist/ に書き出し（どこに置いても動く相対パス）
```

## Google の設定（初回だけ・ご自身の Google アカウントで）

1. https://console.cloud.google.com/ でプロジェクトを作る（名前は何でもよい）
2. 「API とサービス」→「ライブラリ」で **Google Drive API** を有効にする
3. 「OAuth 同意画面」：User Type は「外部」、アプリ名・メールを入れる。スコープは `.../auth/drive.readonly`。「テストユーザー」に自分の Google アカウント（と聴く人のアカウント）を足す。公開ステータスは「テスト」のままでよい
4. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」
   - 承認済みの JavaScript 生成元：ページを置く場所（例 `https://<ユーザー名>.github.io`）と `http://localhost:5175`
5. できたクライアント ID（`…apps.googleusercontent.com`）を `listen/.env.local` に書く（Git には入れない）

```
VITE_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
```

クライアント ID は秘密の値ではありません（ページに埋め込まれて公開されます）。ログインできるのは、手順 3 のテストユーザーに足した人だけです。

## 公開する場所

`npm run build` でできた `dist/` を、HTTPS で配れる場所に置きます（GitHub Pages など）。置いた場所の URL を手順 4 の「JavaScript 生成元」に足してください。iPhone の Safari で開いて「共有」→「ホーム画面に追加」すると、アプリのように開けます。

## 決めたこと

- Drive は読み取り専用（`drive.readonly`）。ファイルを書き換えたり消したりしない
- ログインの鍵は 1 時間で切れる。切れたらログイン画面に戻る（iPhone では押したその場でしかログインの窓を開けないため、自動ではやり直さない）
- 音声は一度に全部読み込んでから鳴らす（1 回 20MB 前後。読み込み中は進み具合を出す）
