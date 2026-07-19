# メガビッグ 布施駅前店 フラットルーム空き確認

GitHub上で取得・保存・閲覧まで完結させる、スマートフォン向け週間ダッシュボードです。

## 現在の実装

| 項目 | 状態 |
|---|---|
| 320px以上のSP週間UI | 実装済み |
| `開始～終了`の個別枠表示 | 実装済み |
| `latest.json`のcacheなし再読込 | 実装済み |
| 60秒ごとの画面内自動再読込 | 実装済み |
| GitHub Pages配備workflow | 実装済み |
| GitHub Actions上の実予約画面走査 | 実装済み・GitHubでの初回smoke待ち |
| 4時間ごとの直近日／日次の7日走査 | workflow実装済み |

`site/data/latest.json`は初回workflow実行前のみUI確認用データです。実予約結果ではないことを画面にも表示し、走査成功後に実データへ自動置換します。

## GitHub Pages

repositoryの `Settings` → `Pages` → `Source` で `GitHub Actions` を選び、`Deploy mobile dashboard` workflowを実行します。

GitHub Pagesは静的サイトです。ページ再読込時にはGitHub上に保存済みの最新JSONを即時表示できますが、再読込そのものからPlaywright走査を同期実行することはできません。新規走査はscheduled workflowまたはActionsの手動実行に分離します。

Pagesの「今すぐ確認を実行」は`Scan and deploy availability` workflowを開きます。走査完了後、開いているPagesは60秒以内に最新JSONへ切り替わります。

## ローカル表示確認

```bash
cd site
python3 -m http.server 4173
```

Chromeで `http://127.0.0.1:4173/` を開きます。

詳細な要件・構成は [ROOM_AVAILABILITY_REQUIREMENTS.md](ROOM_AVAILABILITY_REQUIREMENTS.md) を参照してください。
