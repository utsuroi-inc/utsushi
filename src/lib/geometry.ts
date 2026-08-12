// スクロール計画とセグメント合成の座標計算（DOM非依存の純粋関数）。
// 方針：スクロール計画はCSS px一本で計算し、DPRは合成の最終段（computeCompositePlan）でのみ登場させる。
// さらにcomputeCompositePlanはdevicePixelRatioの理論値ではなく、
// 先頭セグメントの実測px高さから逆算した実効スケールを使う（ブラウザ内部の丸め誤差を実測で吸収するため）。

export function computeScrollSteps(totalHeightCss: number, viewportHeightCss: number): number[] {
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
}

/**
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

  if (n === 1) {
    return {
      canvasWidth: segWidth,
      canvasHeight: segHeights[0],
      placements: [{ destY: 0, sourceY: 0, sourceHeight: segHeights[0] }],
    };
  }

  const scaleY = segHeights[0] / viewportHeightCss;
  const overlapCss = measuredStepsCss[n - 2] + viewportHeightCss - measuredStepsCss[n - 1];
  const overlapPx = Math.min(Math.max(0, Math.round(overlapCss * scaleY)), segHeights[n - 1]);
  const lastSourceHeight = segHeights[n - 1] - overlapPx;

  const placements: SegmentPlacement[] = [];
  let destY = 0;
  for (let i = 0; i < n - 1; i++) {
    placements.push({ destY, sourceY: 0, sourceHeight: segHeights[i] });
    destY += segHeights[i];
  }
  placements.push({ destY, sourceY: overlapPx, sourceHeight: lastSourceHeight });

  return {
    canvasWidth: segWidth,
    canvasHeight: destY + lastSourceHeight,
    placements,
  };
}
