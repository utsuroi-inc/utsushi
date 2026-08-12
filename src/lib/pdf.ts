// PDF生成。jsPDFを知っているのはこのファイルだけに閉じ込める。
//
// 埋め込みはJPEG（DCTDecode）。jsPDFはJPEGバイト列をそのまま埋めるため再エンコードが
// 発生しない。PNGを渡すとデコード→Flate再エンコードが走り、長いページでは
// ピークメモリとファイルサイズが桁違いになる。

import { jsPDF } from 'jspdf';
import { canvasToBlob } from './exporters';
import { PDF_MAX_PAGE_PT, PT_PER_CSS_PX } from './export-defaults';

/**
 * 合成済みcanvasからPDFのBlobを作る。
 *
 * 用紙寸法は実ピクセルではなくCSSピクセル基準で決める。そうすることで、
 * DPR=1の環境とDPR=2の環境で同じページが同じ紙サイズになり、解像度だけが上がる。
 *
 * @param canvas 合成済みキャンバス（実ピクセル）
 * @param scale CSSピクセル→実ピクセルの実測倍率（CompositePlan.scale）
 * @param quality JPEG品質
 */
export async function buildPdfBlob(
  canvas: HTMLCanvasElement,
  scale: number,
  quality: number,
): Promise<Blob> {
  const widthCss = canvas.width / scale;
  const naturalWidthPt = widthCss * PT_PER_CSS_PX;
  // 幅が1辺の上限を超える場合だけ全体を等比縮小する（現実にはまず起きない）
  const fit = naturalWidthPt > PDF_MAX_PAGE_PT ? PDF_MAX_PAGE_PT / naturalWidthPt : 1;
  const widthPt = naturalWidthPt * fit;

  // 1ページに収められる高さ（実ピクセル）。jsPDFは14,400pt超を黙って切り詰めるため、
  // 渡す前にこちらで分割しておく必要がある。
  const maxSlicePx = Math.max(1, Math.floor((PDF_MAX_PAGE_PT / (PT_PER_CSS_PX * fit)) * scale));

  const slices: Array<{ y: number; height: number }> = [];
  for (let y = 0; y < canvas.height; y += maxSlicePx) {
    slices.push({ y, height: Math.min(maxSlicePx, canvas.height - y) });
  }

  let doc: jsPDF | null = null;
  let scratch: HTMLCanvasElement | null = null;

  try {
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      const heightPt = (slice.height / scale) * PT_PER_CSS_PX * fit;
      // jsPDFはorientationと寸法の向きが食い違うと幅と高さを入れ替えるため、
      // 実際の縦横比に合わせて明示する
      const orientation = widthPt >= heightPt ? 'l' : 'p';

      if (!doc) {
        doc = new jsPDF({ unit: 'pt', format: [widthPt, heightPt], orientation });
      } else {
        doc.addPage([widthPt, heightPt], orientation);
      }

      let source = canvas;
      if (slices.length > 1) {
        // 一時canvasは1枚だけ作って使い回す（heightへの代入がクリアも兼ねる）
        scratch ??= document.createElement('canvas');
        scratch.width = canvas.width;
        scratch.height = slice.height;
        const ctx = scratch.getContext('2d', { alpha: false });
        if (!ctx) {
          throw new Error('PDF用canvasの描画コンテキストを取得できませんでした');
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, scratch.width, scratch.height);
        ctx.drawImage(
          canvas,
          0,
          slice.y,
          canvas.width,
          slice.height,
          0,
          0,
          canvas.width,
          slice.height,
        );
        source = scratch;
      }

      const blob = await canvasToBlob(source, 'image/jpeg', quality);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // aliasを渡さないとjsPDFが画像バイト列全体をハッシュして重複検出する（数MBでは無駄）
      doc.addImage(bytes, 'JPEG', 0, 0, widthPt, heightPt, `makimono-page-${i}`);
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
