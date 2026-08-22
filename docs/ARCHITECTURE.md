# Architecture — 写し / utsushi

## 目的

Webページ全体を、過剰な権限を要求せずにChrome拡張だけで撮影・合成・保存する。

## 全体構成

```text
ユーザー操作
   ↓
Service Worker (background.ts)
   ├─ ページ寸法計測
   ├─ スクロール制御
   ├─ captureVisibleTab
   └─ IndexedDBへセグメント保存
             ↓
        result.html
   ├─ セグメント合成
   ├─ PNG / JPEG
   ├─ PDF
   └─ Clipboard
```

## 撮影方式

`chrome.tabs.captureVisibleTab()` で現在の可視領域を撮影し、1ビューポートずつスクロールして取得した画像を結果ページで縦に合成する「スクロール＆スティッチ」方式です。

`chrome.debugger` は使いません。デバッグ権限の警告やインフォバーを避け、利用者へ説明しやすい最小権限を優先しています。

## ページ状態の一時変更

撮影中は次を一時的に変更します。

- smooth scroll / scroll snapの抑制
- `loading="lazy"` 画像のeager化
- 2枚目以降のfixed / sticky要素の非表示（設定ON時）
- 進捗オーバーレイ

### DOM衝突対策

対象サイト自身のIDやdata属性を誤って上書き・削除しないよう、撮影中に作るID・退避属性には `crypto.randomUUID()` で生成した `captureId` を含めています。

例：

```text
utsushi-<captureId>-scroll-reset
utsushi-<captureId>-progress-overlay
data-utsushi-<captureId>-hidden
data-utsushi-<captureId>-loading
```

復元処理は同じ `captureId` の要素・属性だけを対象にします。

## データ保持

Service Workerと結果ページの間で大きな画像データを受け渡すため、IndexedDBを利用します。

- `sessions`：撮影メタ情報
- `segments`：各画面のdata URL

成功時は結果ページの読み出し後に削除します。失敗・キャンセル時はService Worker側で削除します。古い残骸は起動時クリーンアップの対象です。

## 設定

設定は `chrome.storage.local` に保存します。Chrome Syncは使いません。

理由：

- 「ページや設定を外部へ送らない」という説明を単純に保つ
- 端末ごとにキャプチャ環境が異なるため、設定の自動同期を必須としない

## 大きな画像

Chrome / Canvasの安全な上限を超える場合は、結果を縦方向に複数Canvasへ分割します。PDF出力はページ分割として処理します。

## 外部通信

実行時に外部CDNからコードを読み込みません。jsPDF等はビルド時にローカルバンドルします。

`result.ts` の `fetch(dataUrl)` はネットワークURLへのアクセスではなく、ブラウザ内部のdata URLをBlobへ変換する用途です。

## セキュリティ上の境界

この拡張は、利用者が明示的にアイコンを押したタブを対象にします。任意URLをサーバー側で取得する構成ではないため、サーバー型スクリーンショットサービスで問題になるSSRFの攻撃面を持ちません。
