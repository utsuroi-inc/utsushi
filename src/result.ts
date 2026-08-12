import { getSession, deleteSession } from './lib/db';
import { computeCompositePlan } from './lib/geometry';

void main();

async function main(): Promise<void> {
  const captureId = new URLSearchParams(location.search).get('id');
  const canvas = document.getElementById('result-canvas') as HTMLCanvasElement | null;
  const message = document.getElementById('message');

  if (!captureId || !canvas) {
    showMessage(message, '画像IDが指定されていません。');
    return;
  }

  const session = await getSession(captureId);
  if (!session || session.segments.length === 0) {
    showMessage(message, '画像が見つかりませんでした。もう一度撮影してください。');
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

  canvas.width = plan.canvasWidth;
  canvas.height = plan.canvasHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    showMessage(message, '画像の描画に失敗しました。');
    return;
  }

  bitmaps.forEach((bitmap, i) => {
    const placement = plan.placements[i];
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
    bitmap.close();
  });

  await deleteSession(captureId);
}

async function decodeDataUrl(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

function showMessage(el: HTMLElement | null, text: string): void {
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
}
