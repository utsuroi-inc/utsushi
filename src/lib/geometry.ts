// スクロール計画とセグメント合成の座標計算（DOM非依存の純粋関数）。
// 方針：スクロール計画はCSS px一本で計算し、DPRは合成の最終段（computeCompositePlan）でのみ登場させる。
// さらにcomputeCompositePlanはdevicePixelRatioの理論値ではなく、
// 先頭セグメントの実測px高さから逆算した実効スケールを使う（ブラウザ内部の丸め誤差を実測で吸収するため）。

export function computeScrollSteps(totalHeightCss: number, viewportHeightCss: number): number[] {
  if (!Number.isFinite(viewportHeightCss) || viewportHeightCss <= 0) {
    throw new Error(`viewportHeightCss must be positive: ${viewportHeightCss}`);
  }
  const maxScrollY = Math.max(0, totalHeightCss - viewportHeightCss);
  const steps: number[] = [];
  let y = 0;
  while (y < maxScrollY) {
    steps.push(y);
    y = Math.min(y + viewportHeightCss, maxScrollY);
  }
  steps.push(maxScrollY);
  return steps;
}

export interface SegmentPlacement {
  destY: number;
  sourceY: number;
  sourceHeight: number;
}

export interface CompositePlan {
  canvasWidth: number;
  canvasHeight: number;
  placements: SegmentPlacement[];
  /**
   * 実測から逆算したCSSピクセル→実ピクセルの倍率。
   * devicePixelRatioの理論値ではなく実測値なので、PDFの用紙寸法など
   * 「実ピクセルをCSSピクセルに戻す」計算では常にこちらを使う。
   */
  scale: number;
}

/**
 * 各セグメントについて、直前セグメントとの重なりを実測scrollYから求めて上端をクロップする。
 *
 * 高さ計測が実際のスクロール可能範囲より大きいページ（offsetHeightがtransform等で膨らむ、
 * windowがスクロールしないアプリシェル型など）ではスクロールが計画より手前でクランプされ、
 * 中間境界にも重なりが生じる。そのため最終セグメントに限らず全境界で同じ式を適用する
 * （正常なページでは中間の重なりは0になり、結果は変わらない）。
 * 実測ステップが直前と同値（それ以上スクロールできなかった）のセグメントは
 * sourceHeight=0となり、キャンバスに寄与しない。
 *
 * @param segHeights 各セグメントの実測ピクセル高さ（createImageBitmap後の.height）
 * @param segWidth 先頭セグメントの実測ピクセル幅
 * @param measuredStepsCss 各ステップで実際に着地したscrollY（CSS px、計画値ではない）
 * @param viewportHeightCss 測定時のビューポート高さ（CSS px）
 */
export function computeCompositePlan(
  segHeights: number[],
  segWidth: number,
  measuredStepsCss: number[],
  viewportHeightCss: number,
): CompositePlan {
  const n = segHeights.length;
  if (n === 0) {
    throw new Error('segHeights is empty');
  }
  if (measuredStepsCss.length !== n) {
    throw new Error('セグメント数と実測ステップ数が一致しません');
  }
  if (!Number.isFinite(viewportHeightCss) || viewportHeightCss <= 0) {
    throw new Error(`viewportHeightCss must be positive: ${viewportHeightCss}`);
  }

  const scaleY = segHeights[0] / viewportHeightCss;
  const placements: SegmentPlacement[] = [];
  let destY = 0;
  for (let i = 0; i < n; i++) {
    const overlapCss =
      i === 0 ? 0 : measuredStepsCss[i - 1] + viewportHeightCss - measuredStepsCss[i];
    const overlapPx = Math.min(Math.max(0, Math.round(overlapCss * scaleY)), segHeights[i]);
    const sourceHeight = segHeights[i] - overlapPx;
    placements.push({ destY, sourceY: overlapPx, sourceHeight });
    destY += sourceHeight;
  }

  return { canvasWidth: segWidth, canvasHeight: destY, placements, scale: scaleY };
}

// FR-07: 合成キャンバスの安全上限。高さだけでなく総面積にも上限があるため両方で判定する。
// Chromeのcanvas上限より十分小さい値を既定にしている（超えると生成に失敗して白紙になる）。
export const MAX_IMAGE_HEIGHT_PX = 16000;
export const MAX_IMAGE_AREA_PX = 64_000_000;

export interface ImageSplit {
  /** 全体画像における開始Y（実ピクセル） */
  sourceY: number;
  height: number;
}

/**
 * 全体の高さを、1枚あたりの上限（高さ・面積）に収まる複数枚へ分割する。
 * 上限内に収まる場合は1枚だけを返す。
 */
export function computeImageSplits(
  totalWidth: number,
  totalHeight: number,
  maxHeight: number = MAX_IMAGE_HEIGHT_PX,
  maxArea: number = MAX_IMAGE_AREA_PX,
): ImageSplit[] {
  if (totalWidth <= 0 || totalHeight <= 0) {
    throw new Error(`画像の寸法が不正です: ${totalWidth}x${totalHeight}`);
  }

  const byArea = Math.floor(maxArea / totalWidth);
  // 幅が極端に広い場合でも最低1pxは進めて無限ループを避ける
  const limit = Math.max(1, Math.min(maxHeight, byArea));

  const splits: ImageSplit[] = [];
  for (let y = 0; y < totalHeight; y += limit) {
    splits.push({ sourceY: y, height: Math.min(limit, totalHeight - y) });
  }
  return splits;
}
