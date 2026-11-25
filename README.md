# 番組要約（YouTube 新着要約 PWA）

TBS CROSS DIG with Bloomberg / PIVOT / ReHacQ の新着動画を 3 時間おきに検知し、Gemini で詳細要約して、iPhone のホーム画面から読めるようにする。

```
GitHub Actions（3時間おき）
  ├ RSS で新着検知 → Shorts・公開30分以内を除外
  ├ Gemini API に YouTube URL を直接渡して要約（字幕取得は不要）
  ├ data/videos.json をコミット
  └ GitHub Pages にデプロイ ──→ iPhone のホーム画面のWebアプリ（PWA）で閲覧
```

## セットアップ（初回 15 分程度）

1. **Gemini API キーを取得**
   [Google AI Studio](https://aistudio.google.com/apikey) でキーを作成する。
2. **GitHub にリポジトリを作成してアップロード**
   このフォルダの中身を、`.github/` を含めてすべて push する。
   ```bash
   cd yt-summary
   git init && git add . && git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<you>/yt-summary.git
   git push -u origin main
   ```
3. **Secrets を登録**（Settings → Secrets and variables → Actions → New repository secret）
   - `GEMINI_API_KEY`：手順1のキー（必須）
   - `NTFY_TOPIC`：任意。プッシュ通知が欲しい場合のみ（後述）
4. **Pages を有効化**
   Settings → Pages → Build and deployment → Source を **GitHub Actions** にする。
5. **初回実行**
   Actions → `update-summaries` → **Run workflow**。完了後、`https://<you>.github.io/yt-summary/` で表示される。
   初回は各チャンネルの直近 2 日分だけを要約し、それより古い動画はスキップする。
6. **iPhone に追加**
   Safari で上記 URL を開き、共有ボタン →「ホーム画面に追加」。

## 運用上の注意

- **リポジトリの公開範囲**：GitHub Pages は無料プランでは公開リポジトリが必要。要約は URL を知っている人なら誰でも見られる。
- **Gemini の費用**：無料枠は YouTube 動画で 1 日 8 時間分まで。PIVOT と ReHacQ は長尺の動画が多く、日によっては超える。
  - 枠を超えると 429 エラーになる。その回は処理を止め、残りは次回以降に持ち越す（データは失われない）。
  - 取りこぼしを避けたい場合は、AI Studio で課金を有効にする。fps 0.25 と低解像度に設定してあるので、1 時間の動画で入力は約 17 万トークン。
- **長尺動画**：3 時間を超えてエラーになった動画は、先頭 3 時間だけを要約する。その場合、画面に「先頭3時間のみ」と表示される。
- **失敗した動画**：ライブ配信中、メンバー限定などで失敗した動画は最大 6 回（約 18 時間）再試行し、それでも失敗したら諦める。
- **モデル**：既定は `gemini-3.8-flash`。404 のときは `gemini-3.6-flash`、`gemini-3.5-flash` の順に自動で切り替える。
  - 変更したい場合は、Variables に `GEMINI_MODEL` を設定する。

## カスタマイズ

| 変更したいこと | 場所 |
|---|---|
| チャンネルを追加・削除する | `channels.json`（`key`・`name`・`handle` を追加。`web/style.css` の `--c-<key>` で色を指定） |
| 要約の書き方を変える | `scripts/update.py` の `PROMPT` と `SUMMARY_SCHEMA` |
| チェック頻度を変える | `.github/workflows/update.yml` の `cron` |
| 1 回あたりの要約本数（既定 8） | Variables `MAX_PER_RUN` |

## プッシュ通知（任意）

1. iPhone に [ntfy](https://apps.apple.com/app/ntfy/id1625396347) アプリを入れる。
2. 推測されにくいトピック名（例：`yt-sum-8f3k2q9x`）を購読する。
3. 同じトピック名を Secret `NTFY_TOPIC` に登録する。
4. Variables `APP_URL` に Pages の URL を入れると、通知をタップしたときにアプリが開く。

## ローカルで確認

```bash
python3 -m unittest scripts/test_update.py      # 単体テスト
DRY_RUN=1 python3 scripts/update.py              # Gemini を呼ばずに取得のみ確認
GEMINI_API_KEY=xxx python3 scripts/update.py     # 実際に要約
mkdir -p web/data && cp data/videos.json web/data/ && python3 -m http.server -d web 8000
```
