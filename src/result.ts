import { getSession, deleteSession } from './lib/db';
import { computeCompositePlan, computeImageSplits } from './lib/geometry';
import { buildFilename, type FilenameTokens } from './lib/filename';
import { loadSettings, type Settings } from './lib/settings';
import { t, applyI18n, LocalizedError } from './lib/i18n';
import { buildPdfBlob, type VirtualImage } from './lib/pdf';
import {
  canvasToBlob,
  copyCanvasAsPng,
  copyErrorMessageKey,
  downloadBlob,
  registerObjectUrlCleanup,
} from './lib/exporters';

// 連続ダウンロードはブラウザ側で詰まることがあるため、1枚ずつ少し間隔を空ける
const SEQUENTIAL_DOWNLOAD_GAP_MS = 300;

interface ResultContext {
  image: VirtualImage;
  tokens: FilenameTokens;
  settings: Settings;
}

const ui = {
  parts: document.getElementById('parts'),
  message: document.getElementById('message'),
  status: document.getElementById('status'),
  splitNotice: document.getElementById('split-notice'),
  dimensions: document.getElementById('dimensions'),
  zoom: document.getElementById('btn-zoom') as HTMLButtonElement | null,
  png: document.getElementById('btn-png') as HTMLButtonElement | null,
  jpeg: document.getElementById('btn-jpeg') as HTMLButtonElement | null,
  pdf: document.getElementById('btn-pdf') as HTMLButtonElement | null,
  copy: document.getElementById('btn-copy') as HTMLButtonElement | null,
};

const toolbarButtons = [ui.png, ui.jpeg, ui.pdf, ui.copy];
const partButtons: HTMLButtonElement[] = [];

applyI18n();
registerObjectUrlCleanup();
void main();

async function main(): Promise<void> {
  const captureId = new URLSearchParams(location.search).get('id');

  if (!captureId || !ui.parts) {
    showMessage(t('errorNoId'));
    return;
  }

  try {
    const [session, settings] = await Promise.all([getSession(captureId), loadSettings()]);
    if (!session || session.segments.length === 0) {
      showMessage(t('errorNotFound'));
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

    // FR-07: 1枚のcanvasに収まらない大きさなら縦方向に分割する
    const splits = computeImageSplits(plan.canvasWidth, plan.canvasHeight);
    const canvases = splits.map((split) => {
      const canvas = document.createElement('canvas');
      canvas.width = plan.canvasWidth;
      canvas.height = split.height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        throw new Error('canvasの描画コンテキストを取得できませんでした');
      }
      // JPEG/PDFはアルファを持てないため、透明部分が黒くならないよう白で下地を塗る
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas;
    });

    bitmaps.forEach((bitmap, i) => {
      const placement = plan.placements[i];
      // sourceHeight=0（それ以上スクロールできなかった重複セグメント）はdrawImageが
      // InvalidStateErrorを投げるためスキップする
      if (placement.sourceHeight > 0) {
        drawIntoSplits(canvases, splits, bitmap, placement, segWidth);
      }
      bitmap.close();
    });

    const image: VirtualImage = {
      canvases,
      width: plan.canvasWidth,
      height: plan.canvasHeight,
      scale: plan.scale,
    };

    renderParts(image);
    setUpExports({
      image,
      settings,
      tokens: {
        title: meta.pageTitle ?? '',
        urlHost: meta.pageHost ?? '',
        date: meta.capturedAt ? new Date(meta.capturedAt) : new Date(),
      },
    });
  } catch (error) {
    console.error('[makimono] 合成に失敗しました', error);
    if (ui.parts) ui.parts.hidden = true;
    showMessage(t('errorComposeFailed'));
  } finally {
    // 成功・失敗にかかわらず削除する。失敗時に残してもリトライ手段がなく、
    // ページ内容の画像がIndexedDBに残留し続けるだけのため。
    await deleteSession(captureId).catch(() => {});
  }
}

/** 1セグメントを、またがる可能性のある複数の分割canvasへ描く */
function drawIntoSplits(
  canvases: HTMLCanvasElement[],
  splits: Array<{ sourceY: number; height: number }>,
  bitmap: ImageBitmap,
  placement: { destY: number; sourceY: number; sourceHeight: number },
  width: number,
): void {
  const destTop = placement.destY;
  const destBottom = destTop + placement.sourceHeight;

  splits.forEach((split, i) => {
    const splitTop = split.sourceY;
    const splitBottom = splitTop + split.height;
    const from = Math.max(destTop, splitTop);
    const to = Math.min(destBottom, splitBottom);
    if (to <= from) return;

    const ctx = canvases[i].getContext('2d');
    if (!ctx) return;
    ctx.drawImage(
      bitmap,
      0,
      placement.sourceY + (from - destTop),
      width,
      to - from,
      0,
      from - splitTop,
      width,
      to - from,
    );
  });
}

function renderParts(image: VirtualImage): void {
  if (!ui.parts) return;
  const total = image.canvases.length;

  image.canvases.forEach((canvas, i) => {
    const part = document.createElement('div');
    part.className = 'part';

    if (total > 1) {
      const head = document.createElement('div');
      head.className = 'part-head';

      const label = document.createElement('span');
      label.textContent = t('partLabel', [String(i + 1), String(total)]);
      head.appendChild(label);

      const saveButton = document.createElement('button');
      saveButton.textContent = t('btnSavePart');
      saveButton.addEventListener('click', () => {
        void runExport(t('statusSavingPart', [String(i + 1)]), async () => {
          await savePart(i);
        });
      });
      partButtons.push(saveButton);
      head.appendChild(saveButton);

      part.appendChild(head);
    }

    const wrap = document.createElement('div');
    wrap.className = 'part-canvas-wrap';
    wrap.appendChild(canvas);
    part.appendChild(wrap);
    ui.parts?.appendChild(part);
  });

  if (total > 1 && ui.splitNotice) {
    ui.splitNotice.textContent = t('splitNotice', [String(total)]);
    ui.splitNotice.hidden = false;
  }
}

// renderPartsとsetUpExportsの間で共有する。分割保存のハンドラから参照する
let currentContext: ResultContext | null = null;

async function savePart(index: number): Promise<void> {
  if (!currentContext) return;
  const { image, settings } = currentContext;
  const total = image.canvases.length;
  const jpeg = settings.imageFormat === 'jpeg';
  const blob = await canvasToBlob(
    image.canvases[index],
    jpeg ? 'image/jpeg' : 'image/png',
    jpeg ? settings.jpegQuality : undefined,
  );
  downloadBlob(blob, partFilename(currentContext, jpeg ? 'jpg' : 'png', index, total));
}

function setUpExports(context: ResultContext): void {
  currentContext = context;
  const { image } = context;
  const widthCss = Math.round(image.width / image.scale);
  const heightCss = Math.round(image.height / image.scale);

  if (ui.dimensions) {
    const base = t('dimensions', [format(widthCss), format(heightCss)]);
    ui.dimensions.textContent =
      image.scale !== 1
        ? `${base} ${t('dimensionsActual', [format(image.width), format(image.height)])}`
        : base;
  }

  for (const button of toolbarButtons) {
    if (button) button.disabled = false;
  }
  if (ui.zoom) ui.zoom.disabled = false;

  setUpZoom(image, widthCss);

  ui.png?.addEventListener('click', () => {
    void runExport(t('statusSavingPng'), () => saveAll(context, 'png'));
  });

  ui.jpeg?.addEventListener('click', () => {
    void runExport(t('statusSavingJpeg'), () => saveAll(context, 'jpg'));
  });

  ui.pdf?.addEventListener('click', () => {
    void runExport(t('statusSavingPdf'), async () => {
      const blob = await buildPdfBlob(image, context.settings.pdfPaper, context.settings.jpegQuality);
      downloadBlob(blob, buildFilename(context.settings.filenameTemplate, context.tokens, 'pdf'));
    });
  });

  // クリップボードだけは非asyncハンドラ。awaitを挟むとユーザー操作の文脈が切れて
  // NotAllowedErrorになるため、copyCanvasAsPngを同期的に呼ぶ
  ui.copy?.addEventListener('click', () => {
    if (image.canvases.length > 1) {
      // 分割された画像は1枚としてコピーできない
      setStatus(t('errorCopySplit'));
      return;
    }
    setStatus(t('statusCopying'));
    copyCanvasAsPng(image.canvases[0])
      .then(() => setStatus(t('statusCopied')))
      .catch((error: unknown) => {
        console.error('[makimono] コピーに失敗しました', error);
        setStatus(t(copyErrorMessageKey(error)));
      });
  });
}

/** FR-07「すべて保存（順次ダウンロード）」。分割されていない場合は1枚だけ保存する */
async function saveAll(context: ResultContext, extension: 'png' | 'jpg'): Promise<void> {
  const { image, settings } = context;
  const total = image.canvases.length;
  const type = extension === 'jpg' ? 'image/jpeg' : 'image/png';
  const quality = extension === 'jpg' ? settings.jpegQuality : undefined;

  for (let i = 0; i < total; i++) {
    if (total > 1) {
      setStatus(t('statusSavingPart', [String(i + 1)]));
    }
    const blob = await canvasToBlob(image.canvases[i], type, quality);
    downloadBlob(blob, partFilename(context, extension, i, total));
    if (i < total - 1) {
      await sleep(SEQUENTIAL_DOWNLOAD_GAP_MS);
    }
  }
}

function partFilename(
  context: ResultContext,
  extension: string,
  index: number,
  total: number,
): string {
  const suffix = total > 1 ? `_${index + 1}of${total}` : '';
  return buildFilename(context.settings.filenameTemplate, context.tokens, extension, suffix);
}

function setUpZoom(image: VirtualImage, widthCss: number): void {
  let actualSize = false;
  ui.zoom?.addEventListener('click', () => {
    actualSize = !actualSize;
    // 実ピクセル等倍ではなくCSSピクセル等倍にする。Retinaで実ピクセル等倍にすると
    // 元のページの2倍の大きさになり「等倍」の直感に反するため。
    for (const canvas of image.canvases) {
      canvas.classList.toggle('actual-size', actualSize);
      canvas.style.width = actualSize ? `${widthCss}px` : '';
    }
    if (ui.zoom) ui.zoom.textContent = actualSize ? t('zoomFit') : t('zoomActual');
  });
}

async function runExport(pendingMessage: string, task: () => Promise<void>): Promise<void> {
  setBusy(true);
  setStatus(pendingMessage);
  try {
    await task();
    setStatus(t('statusSaved'));
  } catch (error) {
    console.error('[makimono] 書き出しに失敗しました', error);
    // 内部エラーのmessageはそのまま出さない（_localesを通らず言語が混ざるため）
    setStatus(error instanceof LocalizedError ? t(error.messageKey) : t('errorExportFailed'));
  } finally {
    setBusy(false);
  }
}

function setBusy(busy: boolean): void {
  for (const button of [...toolbarButtons, ...partButtons]) {
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
  return n.toLocaleString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function decodeDataUrl(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}
