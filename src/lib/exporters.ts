// 結果ページからの書き出し処理。canvas → Blob → 保存 / クリップボード。
//
// toDataURL は使わない（base64文字列がヒープに乗るため。長いページでは数百MBになる）。
// 保存は <a download> + blob: URL。同一オリジンのblob:なので downloads 権限は不要。

import { LocalizedError } from './i18n';

// 発行済みObjectURLを保持し、一定時間後とページ離脱時に解放する。
// ダウンロード直後に即revokeすると、進行中の保存が中断されうるため猶予を置く。
const pendingUrls = new Set<string>();
const URL_LIFETIME_MS = 60_000;

export function registerObjectUrlCleanup(): void {
  window.addEventListener('pagehide', () => {
    for (const url of pendingUrls) {
      URL.revokeObjectURL(url);
    }
    pendingUrls.clear();
  });
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          // 画像が大きすぎるとnullが返る
          reject(new LocalizedError('errorTooLarge', 'canvas.toBlob returned null'));
        }
      },
      type,
      quality,
    );
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  pendingUrls.add(url);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    if (pendingUrls.delete(url)) {
      URL.revokeObjectURL(url);
    }
  }, URL_LIFETIME_MS);
}

/**
 * PNGとしてクリップボードへ書き込む。
 *
 * 重要：この関数はクリックハンドラから**同期的に**呼ぶこと。
 * 呼び出し前にawaitを挟むとユーザー操作の文脈（transient activation）が切れて
 * NotAllowedErrorになる。Blob生成の完了は待たず、Promiseのまま ClipboardItem に渡す
 * （ClipboardItemはBlobを解決するPromiseを受け取れる）。
 */
export function copyCanvasAsPng(canvas: HTMLCanvasElement): Promise<void> {
  const blobPromise = canvasToBlob(canvas, 'image/png');
  const item = new ClipboardItem({ 'image/png': blobPromise });
  return navigator.clipboard.write([item]);
}

/** 文言そのものではなくメッセージキーを返す（UI文言は_locales側に集約するため） */
export function copyErrorMessageKey(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  // タブが背面だったりDevToolsにフォーカスがある場合はNotAllowedErrorになる
  return name === 'NotAllowedError' ? 'errorCopyNotAllowed' : 'errorCopyFailed';
}
