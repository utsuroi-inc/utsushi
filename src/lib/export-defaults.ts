// FR-09の既定値を1箇所に集約する。
// フェーズ4でオプションページ（chrome.storage.sync）を付けるときは、
// この値の参照元を差し替えるだけで済むようにしておく。

export type PdfPaper = 'image' | 'a4';

export const EXPORT_DEFAULTS = {
  jpegQuality: 0.92,
  // PDFに埋め込むJPEGの品質。画像保存用とは用途が違うため別に持つ
  pdfJpegQuality: 0.92,
  // 'a4'（A4縦に自動分割）はFR-08(b)。フェーズ4で実装する
  pdfPaper: 'image' as PdfPaper,
  filenameTemplate: '{title}_{yyyyMMdd-HHmmss}',
} as const;

// PDFの1辺の仕様上限は14,400pt。jsPDFは超過分を警告付きで黙って切り詰めるため、
// 渡す前に自前で分割する。安全マージンを取ってこの値を閾値にする。
export const PDF_MAX_PAGE_PT = 14000;

// MDN: 1px = 1in/96、1pt = 1in/72 なので 1 CSS px = 0.75 pt
export const PT_PER_CSS_PX = 0.75;
