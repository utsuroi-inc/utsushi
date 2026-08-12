import { prepareAndMeasure, scrollAndSettle, restorePage } from './lib/inject';
import { computeScrollSteps } from './lib/geometry';
import { appendSegment, saveSessionMeta } from './lib/db';

// FR-02.4: captureVisibleTabのレート制限（約2回/秒）を守るための最低間隔。
// オプション化（既定600ms、200〜2000ms）はフェーズ4のスコープなので、ここでは固定値。
const MIN_CAPTURE_INTERVAL_MS = 600;

const runningTabIds = new Set<number>();

chrome.action.onClicked.addListener((tab) => {
  void handleClick(tab);
});

async function handleClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || tab.windowId === undefined) {
    console.error('[makimono] tab.id または windowId が取得できませんでした');
    return;
  }
  if (runningTabIds.has(tab.id)) {
    // 撮影中の再クリックは無視する（キャンセルUIはフェーズ2）
    return;
  }

  runningTabIds.add(tab.id);
  try {
    await runFullPageCapture(tab.id, tab.windowId);
  } finally {
    runningTabIds.delete(tab.id);
  }
}

async function runFullPageCapture(tabId: number, windowId: number): Promise<void> {
  const captureId = crypto.randomUUID();
  let original: { scrollX: number; scrollY: number } | null = null;

  try {
    const [measurementInjection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: prepareAndMeasure,
    });
    const measurement = measurementInjection.result;
    if (!measurement) {
      throw new Error('ページの測定に失敗しました');
    }
    original = measurement.original;

    const steps = computeScrollSteps(measurement.totalHeightCss, measurement.viewportHeightCss);
    const actualStepsCss: number[] = [];
    let lastCaptureAt = 0;

    for (let i = 0; i < steps.length; i++) {
      const [settledInjection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollAndSettle,
        args: [steps[i]],
      });
      const settled = settledInjection.result;
      if (!settled) {
        throw new Error(`スクロールの実行に失敗しました（step ${i}）`);
      }
      actualStepsCss.push(settled.scrollY);

      // レート制限の下限保証：計測起点をcaptureVisibleTab直前に置くことで、
      // scrollAndSettle等がどれだけ時間を使っても実効間隔が縮まないようにする。
      const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) {
        await sleep(wait);
      }

      lastCaptureAt = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      await appendSegment(captureId, i, dataUrl);
    }

    await saveSessionMeta(captureId, {
      viewportWidthCss: measurement.viewportWidthCss,
      viewportHeightCss: measurement.viewportHeightCss,
      totalHeightCss: measurement.totalHeightCss,
      dpr: measurement.dpr,
      actualStepsCss,
    });

    await chrome.tabs.create({
      url: chrome.runtime.getURL(`result.html?id=${captureId}`),
    });
  } catch (error) {
    // フェーズ1時点では最小限のログのみ。ユーザー向けの通知・リトライはフェーズ5で扱う。
    console.error('[makimono] フルページキャプチャに失敗しました', error);
  } finally {
    if (original) {
      await chrome.scripting
        .executeScript({ target: { tabId }, func: restorePage, args: [original] })
        .catch((error) => console.error('[makimono] ページ状態の復元に失敗しました', error));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
