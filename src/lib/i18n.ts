// FR-10: 文言は_locales経由。日本語が基準（default_locale: ja）。

/**
 * 利用者に見せてよい文言のキーを持つエラー。
 * 内部エラーのmessageをそのままUIに出すと、_localesを通らず言語が混ざるため、
 * 画面に出す可能性のある失敗はこれで投げてキーだけを運ぶ。
 */
export class LocalizedError extends Error {
  readonly messageKey: string;

  constructor(messageKey: string, detail?: string) {
    super(detail ?? messageKey);
    this.name = 'LocalizedError';
    this.messageKey = messageKey;
  }
}

export function t(key: string, substitutions?: string[]): string {
  const message = chrome.i18n.getMessage(key, substitutions);
  // キー名の打ち間違いは空文字が返るだけで気付きにくいため、開発時に見えるようにする
  if (!message) {
    console.warn('[makimono] 未定義のメッセージキー:', key);
    return key;
  }
  return message;
}

/**
 * data-i18n属性を持つ要素にメッセージを流し込む。
 *   data-i18n       → textContent
 *   data-i18n-title → title属性
 * HTML側に文言を直書きしないための仕組み。
 */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  });
  const titleKey = document.documentElement.dataset.i18nDocumentTitle;
  if (titleKey) {
    document.title = t(titleKey);
  }
  document.documentElement.lang = chrome.i18n.getUILanguage();
}
