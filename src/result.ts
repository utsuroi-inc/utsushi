import { getSession, deleteSession } from './lib/db';
import { computeCompositePlan } from './lib/geometry';
import { buildFilename, type FilenameTokens } from './lib/filename';
import { EXPORT_DEFAULTS } from './lib/export-defaults';
import { buildPdfBlob } from './lib/pdf';
import {
  canvasToBlob,
  copyCanvasAsPng,
  describeCopyError,
  downloadBlob,
  registerObjectUrlCleanup,
} from './lib/exporters';

interface ResultContext {
  canvas: HTMLCanvasElement;
  scale: number;
  tokens: FilenameTokens;
}

const ui = {
  canvas: document.getElementById('result-canvas') as HTMLCanvasElement | null,
  message: document.getElementById('message'),
  status: document.getElementById('status'),
  dimensions: document.getElementById('dimensions'),
  zoom: document.getElementById('btn-zoom') as HTMLButtonElement | null,
  png: document.getElementById('btn-png') as HTMLButtonElement | null,
  jpeg: document.getElementById('btn-jpeg') as HTMLButtonElement | null,
  pdf: document.getElementById('btn-pdf') as HTMLButtonElement | null,
  copy: document.getElementById('btn-copy') as HTMLButtonElement | null,
};

const exportButtons = [ui.png, ui.jpeg, ui.pdf, ui.copy];

registerObjectUrlCleanup();
void main();

async function main(): Promise<void> {
  const captureId = new URLSearchParams(location.search).get('id');

  if (!captureId || !ui.canvas) {
    showMessage('画像IDが指定されていません。');
    return;
  }

  try {
    const session = await getSession(captureId);
    if (!session || session.segments.length === 0) {
      showMessage('画像が見つかりませんでした。もう一度撮影してください。');
      return;
    }

    const { meta, segments } = session;
    const bitmaps = await Promise.all(segments.map(decodeDataUrl));

    const segWidth = bitmaps[0].width;
    for (const bitmap of bitmaps) {
      if (bitmap.width !== segWidth) {
        console.warn('[makimono] セグメント幅が揃っていません', { segWidth, actual: bitmap.width });
      }
    }
    const expectedWidth = Math.round(meta.viewportWidthCss * meta.dpr);
    if (segWidth !== expectedWidth) {
      console.warn('[makimono] 実測幅が理論値（viewportWidthCss×dpr）と異なります', {
        segWidth,
        expectedWidth,
      });
    }

    const plan = computeCompositePlan(
      bitmaps.map((bitmap) => bitmap.height),
      segWidth,
      meta.actualStepsCss,
      meta.viewportHeightCss,
    );

    ui.canvas.width = plan.canvasWidth;
    ui.canvas.height = plan.canvasHeight;
    const ctx = ui.canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      throw new Error('canvasの描画コンテキストを取得できませんでした');
    }
    // JPEG/PDFはアルファを持てないため、透明部分が黒くならないよう白で下地を塗る
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ui.canvas.width, ui.canvas.height);

    bitmaps.forEach((bitmap, i) => {
      const placement = plan.placements[i];
      // sourceHeight=0（それ以上スクロールできなかった重複セグメント）はdrawImageが
      // InvalidStateErrorを投げるためスキップする
      if (placement.sourceHeight > 0) {
        ctx.drawImage(
          bitmap,
          0,
          placement.sourceY,
          segWidth,
          placement.sourceHeight,
          0,
          placement.destY,
          segWidth,
          placement.sourceHeight,
        );
      }
      bitmap.close();
    });

    setUpExports({
      canvas: ui.canvas,
      scale: plan.scale,
      tokens: {
        title: meta.pageTitle ?? '',
        urlHost: meta.pageHost ?? '',
        date: meta.capturedAt ? new Date(meta.capturedAt) : new Date(),
      },
    });
  } catch (error) {
    console.error('[makimono] 合成に失敗しました', error);
    if (ui.canvas) ui.canvas.hidden = true;
    showMessage('画像の合成に失敗しました。もう一度撮影してください。');
  } finally {
    // 成功・失敗にかかわらず削除する。失敗時に残してもリトライ手段がなく、
    // ページ内容の画像がIndexedDBに残留し続けるだけのため。
    await deleteSession(captureId).catch(() => {});
  }
}

function setUpExports(context: ResultContext): void {
  const { canvas, scale } = context;
  const widthCss = Math.round(canvas.width / scale);
  const heightCss = Math.round(canvas.height / scale);
  if (ui.dimensions) {
    ui.dimensions.textContent =
      `${format(widthCss)} × ${format(heightCss)} px` +
      (scale !== 1 ? `（実寸 ${format(canvas.width)} × ${format(canvas.height)}）` : '');
  }

  for (const button of exportButtons) {
    if (button) button.disabled = false;
  }

  setUpZoom(canvas, widthCss);

  ui.png?.addEventListener('click', () => {
    void runExport('PNGを書き出し中…', async () => {
      const blob = await canvasToBlob(canvas, 'image/png');
      downloadBlob(blob, filenameFor(context, 'png'));
    });
  });

  ui.jpeg?.addEventListener('click', () => {
    void runExport('JPEGを書き出し中…', async () => {
      const blob = await canvasToBlob(canvas, 'image/jpeg', EXPORT_DEFAULTS.jpegQuality);
      downloadBlob(blob, filenameFor(context, 'jpg'));
    });
  });

  ui.pdf?.addEventListener('click', () => {
    void runExport('PDFを作成中…', async () => {
      const blob = await buildPdfBlob(canvas, scale, EXPORT_DEFAULTS.pdfJpegQuality);
      downloadBlob(blob, filenameFor(context, 'pdf'));
    });
  });

  // クリップボードだけは非asyncハンドラ。awaitを挟むとユーザー操作の文脈が切れて
  // NotAllowedErrorになるため、copyCanvasAsPngを同期的に呼ぶ
  ui.copy?.addEventListener('click', () => {
    setStatus('クリップボードにコピー中…');
    copyCanvasAsPng(canvas)
      .then(() => setStatus('クリップボードにコピーしました'))
      .catch((error: unknown) => {
        console.error('[makimono] コピーに失敗しました', error);
        setStatus(describeCopyError(error));
      });
  });
}

function setUpZoom(canvas: HTMLCanvasElement, widthCss: number): void {
  let actualSize = false;
  ui.zoom?.addEventListener('click', () => {
    actualSize = !actualSize;
    // 実ピクセル等倍ではなくCSSピクセル等倍にする。Retinaで実ピクセル等倍にすると
    // 元のページの2倍の大きさになり「等倍」の直感に反するため。
    canvas.classList.toggle('actual-size', actualSize);
    canvas.style.width = actualSize ? `${widthCss}px` : '';
    if (ui.zoom) ui.zoom.textContent = actualSize ? '全体を表示' : '等倍で表示';
  });
}

async function runExport(pendingMessage: string, task: () => Promise<void>): Promise<void> {
  setBusy(true);
  setStatus(pendingMessage);
  try {
    await task();
    setStatus('保存しました');
  } catch (error) {
    console.error('[makimono] 書き出しに失敗しました', error);
    setStatus(error instanceof Error ? error.message : '書き出しに失敗しました');
  } finally {
    setBusy(false);
  }
}

function filenameFor(context: ResultContext, extension: string): string {
  return buildFilename(EXPORT_DEFAULTS.filenameTemplate, context.tokens, extension);
}

function setBusy(busy: boolean): void {
  for (const button of exportButtons) {
    if (button) button.disabled = busy;
  }
}

function setStatus(text: string): void {
  if (!ui.status) return;
  ui.status.textContent = text;
  ui.status.hidden = false;
}

function showMessage(text: string): void {
  if (!ui.message) return;
  ui.message.textContent = text;
  ui.message.hidden = false;
}

function format(n: number): string {
  return n.toLocaleString('ja-JP');
}

async function decodeDataUrl(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}
