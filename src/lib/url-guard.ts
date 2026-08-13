// §8.1 キャプチャ不可のURLを、撮影を始める前に判定する（DOM非依存の純粋関数）。
//
// file:// はここでは弾かない。ユーザーが「ファイルのURLへのアクセスを許可する」を
// 有効にしていれば撮影できるため、実際に試して失敗したときに案内する
// （設定状態を先に知る手段を持つより、試して分岐するほうが確実なため）。

/** 撮影できない理由。null なら試してよい。 */
export type BlockReason = 'internal' | 'webstore' | 'unsupportedScheme';

const INTERNAL_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
];

const CAPTURABLE_SCHEMES = ['http:', 'https:', 'file:'];

const WEB_STORE_HOSTS = ['chromewebstore.google.com'];

export function getBlockReason(url: string | undefined): BlockReason | null {
  // URLが読めない場合は判定できないので、試したうえで失敗時に案内する
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (INTERNAL_SCHEMES.includes(parsed.protocol)) {
    return 'internal';
  }
  if (
    WEB_STORE_HOSTS.includes(parsed.hostname) ||
    (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))
  ) {
    // ウェブストア上では拡張機能のスクリプト実行がブロックされる
    return 'webstore';
  }
  if (!CAPTURABLE_SCHEMES.includes(parsed.protocol)) {
    return 'unsupportedScheme';
  }
  return null;
}

export function blockReasonMessageKey(reason: BlockReason): string {
  switch (reason) {
    case 'internal':
      return 'errorBlockedInternal';
    case 'webstore':
      return 'errorBlockedWebStore';
    case 'unsupportedScheme':
      return 'errorBlockedScheme';
  }
}

export function isFileUrl(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith('file://');
}
