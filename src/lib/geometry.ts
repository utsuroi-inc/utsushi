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

  return { canvasWidth: segWidth, canvasHeight: destY, placements };
}
