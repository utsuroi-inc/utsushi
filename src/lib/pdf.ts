// PDF生成。jsPDFを知っているのはこのファイルだけに閉じ込める。
//
// 埋め込みはJPEG（DCTDecode）。jsPDFはJPEGバイト列をそのまま埋めるため再エンコードが
// 発生しない。PNGを渡すとデコード→Flate再エンコードが走り、長いページでは
// ピークメモリとファイルサイズが桁違いになる。
//
// FR-07で画像が複数枚に分割されても、PDFは1ファイルにまとめる（分割の影響を受けない）。
// そのため複数canvasを縦に連なった1枚の仮想画像として扱う。

import { jsPDF } from 'jspdf';
import { canvasToBlob } from './exporters';
import type { PdfPaper } from './settings';

// PDFの1辺の仕様上限は14,400pt。jsPDFは超過分を警告付きで黙って切り詰めるため、
// 渡す前に自前で分割する。安全マージンを取ってこの値を閾値にする。
export const PDF_MAX_PAGE_PT = 14000;

// MDN: 1px = 1in/96、1pt = 1in/72 なので 1 CSS px = 0.75 pt
export const PT_PER_CSS_PX = 0.75;

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

export interface VirtualImage {
  /** 縦に連なる画像。1枚に収まる場合は要素1つ */
  canvases: HTMLCanvasElement[];
  width: number;
  height: number;
  /** CSSピクセル→実ピクセルの実測倍率 */
  scale: number;
}

/** 仮想画像の指定範囲（実ピクセル）をコンテキストへ描く。canvasの境界をまたいでもよい。 */
function drawRange(
  ctx: CanvasRenderingContext2D,
  image: VirtualImage,
  sourceY: number,
  height: number,
): void {
  let offset = 0;
  for (const canvas of image.canvases) {
    const top = offset;
    const bottom = offset + canvas.height;
    offset = bottom;

    const from = Math.max(sourceY, top);
    const to = Math.min(sourceY + height, bottom);
    if (to <= from) continue;

    ctx.drawImage(
      canvas,
      0,
      from - top,
      image.width,
      to - from,
      0,
      from - sourceY,
      image.width,
      to - from,
    );
  }
}

/**
 * 合成済み画像からPDFのBlobを作る。
 *
 * 用紙寸法は実ピクセルではなくCSSピクセル基準で決める。そうすることで、
 * DPR=1の環境とDPR=2の環境で同じページが同じ紙サイズになり、解像度だけが上がる。
 */
export async function buildPdfBlob(
  image: VirtualImage,
  paper: PdfPaper,
  quality: number,
): Promise<Blob> {
  const naturalWidthPt = (image.width / image.scale) * PT_PER_CSS_PX;

  // 画像サイズモードは幅をそのまま使い、上限を超える場合だけ全体を等比縮小する。
  // A4モードは常にA4幅へ合わせる。
  const targetWidthPt =
    paper === 'a4' ? A4_WIDTH_PT : Math.min(naturalWidthPt, PDF_MAX_PAGE_PT);
  const fit = targetWidthPt / naturalWidthPt;
  const widthPt = targetWidthPt;

  // 1ページに載せられる高さ（実ピクセル換算）
  const maxPageHeightPt = paper === 'a4' ? A4_HEIGHT_PT : PDF_MAX_PAGE_PT;
  const sliceHeightPx = Math.max(
    1,
    Math.floor((maxPageHeightPt / (PT_PER_CSS_PX * fit)) * image.scale),
  );

  const slices: Array<{ sourceY: number; height: number }> = [];
  for (let y = 0; y < image.height; y += sliceHeightPx) {
    slices.push({ sourceY: y, height: Math.min(sliceHeightPx, image.height - y) });
  }

  let doc: jsPDF | null = null;
  let scratch: HTMLCanvasElement | null = null;

  try {
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      const imageHeightPt = (slice.height / image.scale) * PT_PER_CSS_PX * fit;
      // A4モードでは最終ページも用紙サイズを保つ（画像が短い分は余白になる）
      const pageHeightPt = paper === 'a4' ? A4_HEIGHT_PT : imageHeightPt;
      // jsPDFはorientationと寸法の向きが食い違うと幅と高さを入れ替えるため、
      // 実際の縦横比に合わせて明示する
      const orientation = widthPt >= pageHeightPt ? 'l' : 'p';

      if (!doc) {
        doc = new jsPDF({ unit: 'pt', format: [widthPt, pageHeightPt], orientation });
      } else {
        doc.addPage([widthPt, pageHeightPt], orientation);
      }

      let source: HTMLCanvasElement;
      if (slices.length === 1 && image.canvases.length === 1) {
        // 分割なしの一般的なケースでは一時canvasを作らずに済ませる
        source = image.canvases[0];
      } else {
        // 一時canvasは1枚だけ作って使い回す（heightへの代入がクリアも兼ねる）
        scratch ??= document.createElement('canvas');
        scratch.width = image.width;
        scratch.height = slice.height;
        const ctx = scratch.getContext('2d', { alpha: false });
        if (!ctx) {
          throw new Error('PDF用canvasの描画コンテキストを取得できませんでした');
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, scratch.width, scratch.height);
        drawRange(ctx, image, slice.sourceY, slice.height);
        source = scratch;
      }

      const blob = await canvasToBlob(source, 'image/jpeg', quality);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // aliasを渡さないとjsPDFが画像バイト列全体をハッシュして重複検出する（数MBでは無駄）
      doc.addImage(bytes, 'JPEG', 0, 0, widthPt, imageHeightPt, `makimono-page-${i}`);
    }

    if (!doc) {
      throw new Error('PDFに書き出す内容がありません');
    }
    return doc.output('blob');
  } finally {
    if (scratch) {
      scratch.width = 0;
      scratch.height = 0;
    }
  }
}
