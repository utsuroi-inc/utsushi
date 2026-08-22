# GitHub公開手順

この公開版は、元のPrivateリポジトリをそのままPublic化するのではなく、**株式会社うつろいOrganizationに新しいクリーンなリポジトリを作り、初回コミットとして入れる**ことを推奨します。

理由：元リポジトリのGit履歴はこのZIPでは監査しておらず、削除済みの内部情報や秘密情報が過去コミットに残っている可能性を完全には否定できないためです。

## 推奨リポジトリ

```text
https://github.com/utsuroi-inc/utsushi
```

## 公開前の最終確認

1. このZIPを展開する
2. Node.js 20以上で `npm install`
3. `npm run typecheck`
4. `npm run build`
5. `dist/` を `chrome://extensions` から読み込む
6. 通常ページ、長いページ、固定ヘッダー、lazy-loadページで実機確認
7. DevTools Networkで、拡張機能自身による外部送信がないことを確認
8. README・PRIVACY・USAGEの表示を確認
9. 会社の正式な「写し」アイコンがある場合は `src/icons/` を差し替える

## GitHub Web画面から公開する場合

1. `utsuroi-inc` Organizationで **New repository**
2. Repository name：`utsushi`
3. Visibility：`Public`
4. README等の自動追加はOFF（このZIPに含まれています）
5. 作成後、`Add file` → `Upload files`
6. このZIPを展開した中身をアップロード
7. Commit message例：`Initial public release of utsushi`

## Gitコマンドを使う場合

```bash
git init
git add .
git commit -m "Initial public release of utsushi"
git branch -M main
git remote add origin https://github.com/utsuroi-inc/utsushi.git
git push -u origin main
```

## 公開後

- Organizationトップで `utsushi` をPin
- `https://utsuroi-inc.jp/works` のHPスキャンツール詳細からGitHubへリンク
- GitHub READMEから公式Worksへ戻るリンクはすでに入っています
- 実機テスト後にReleaseタグ（例：`v0.0.2`）を付ける
