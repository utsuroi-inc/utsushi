# 公開版 v0.0.2 変更点

2026-08-22 の公開前レビューをもとに、個人リポジトリの開発版から公開向けに整理しました。

## セキュリティ・プライバシー

- 撮影中にページへ追加するID / data属性を `captureId`（UUID）で名前空間化
- 対象サイト自身の同名ID / data属性を誤って変更・削除するリスクを低減
- 設定保存を `chrome.storage.sync` から `chrome.storage.local` へ変更
- ページ内容・URL・画像を外部送信しない方針を `PRIVACY.md` に明文化
- 内部開発メモ・案件固有の記述を公開パッケージから除外

## 公開リポジトリ向け整備

- READMEを株式会社うつろいの公開成果物として再構成
- `USAGE.md`（利用者向け使い方マニュアル）を追加
- `docs/ARCHITECTURE.md`（技術構成）を追加
- `PRIVACY.md` を追加
- `package.json` / `package-lock.json` の旧プロジェクト名を `utsushi` に統一
- Manifestに公式Works URL（`homepage_url`）を追加
- 単色プレースホルダーのアイコンを、縦長ページをモチーフにした独自アイコンへ差し替え
- 編集用SVGを `assets/utsushi-icon.svg` として追加
- バージョンを `0.0.2` へ更新

## 第三者ライセンス

- pakoのMIT部分に加え、zlib由来部分のZlibライセンス本文を `licenses/zlib.txt` として同梱
- `licenses/README.md` を公開向けに整理

## 検証

- TypeScriptのソース一式を簡易型チェック（Chrome API / jsPDFは検証用shimを使用）
- JSONファイルの構文確認
- 秘密情報らしき文字列、案件固有名、`chrome.storage.sync` の残存を静的検索

## 未実施

このZIPにはGit履歴が含まれていないため、元のPrivateリポジトリの過去コミットに秘密情報が存在しないかは検証していません。

また、依存パッケージのオンライン取得がこの作業環境では完了しなかったため、実依存を用いた `npm run build` とChrome実機テストは別途必要です。
