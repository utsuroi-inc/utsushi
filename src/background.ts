import {
  prepareAndMeasure,
  scrollAndSettle,
  restorePage,
  prepareOverlay,
  hideOverlay,
  showOverlayProgress,
  hideFixedElements,
} from './lib/inject';
import { computeScrollSteps } from './lib/geometry';
import { appendSegment, saveSessionMeta, deleteSession } from './lib/db';

// FR-02.4: captureVisibleTabのレート制限（約2回/秒）を守るための最低間隔。
// オプション化（既定600ms、200〜2000ms）はフェーズ4のスコープなので、ここでは固定値。
const MIN_CAPTURE_INTERVAL_MS = 600;

interface CaptureState {
  cancelled: boolean;
}

const runningCaptures = new Map<number, CaptureState>();

class CaptureCancelledError extends Error {
  constructor() {
    super('キャプチャはキャンセルされました');
  }
}

chrome.action.onClicked.addListener((tab) => {
  void handleClick(tab);
});

async function handleClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || tab.windowId === undefined) {
    console.error('[makimono] tab.id または windowId が取得できませんでした');
    return;
  }

  // FR-05: キャプチャ中の再クリックはキャンセルとして扱う
  const existing = runningCaptures.get(tab.id);
  if (existing) {
    existing.cancelled = true;
    return;
  }

  const state: CaptureState = { cancelled: false };
  runningCaptures.set(tab.id, state);
  try {
    await runFullPageCapture(tab.id, tab.windowId, state);
  } finally {
    // 成功・失敗・キャンセルのいずれでも必ず解放する。
    // 残すと次のクリックが「新規撮影」でなく「キャンセル」と誤認され、再撮影できなくなる。
    runningCaptures.delete(tab.id);
  }
}

async function runFullPageCapture(
  tabId: number,
  windowId: number,
  state: CaptureState,
): Promise<void> {
  const captureId = crypto.randomUUID();
  let original: { scrollX: number; scrollY: number } | null = null;
  let succeeded = false;

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

    await chrome.scripting.executeScript({ target: { tabId }, func: prepareOverlay });

    const actualStepsCss: number[] = [];
    let lastCaptureAt = 0;

    for (let i = 0; i < steps.length; i++) {
      if (state.cancelled) {
        throw new CaptureCancelledError();
      }

      if (i === 1) {
        // FR-03: 1枚目には固定要素を写し、2枚目以降では隠す
        await chrome.scripting.executeScript({ target: { tabId }, func: hideFixedElements });
      }

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

      // FR-05: キャプチャの瞬間はオーバーレイを必ず非表示にする（描画反映まで待つ）
      await chrome.scripting.executeScript({ target: { tabId }, func: hideOverlay });

      // レート制限の下限保証：計測起点をcaptureVisibleTab直前に置くことで、
      // scrollAndSettle等がどれだけ時間を使っても実効間隔が縮まないようにする。
      const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) {
        await sleep(wait);
      }

      lastCaptureAt = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      await appendSegment(captureId, i, dataUrl);

      const percent = Math.round(((i + 1) / steps.length) * 100);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: showOverlayProgress,
        args: [percent],
      });
      await chrome.action.setBadgeText({ tabId, text: `${percent}%` });
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
    succeeded = true;
  } catch (error) {
    if (error instanceof CaptureCancelledError) {
      console.log('[makimono] キャプチャをキャンセルしました');
    } else {
      // ユーザー向けの通知・リトライはフェーズ5で扱う
      console.error('[makimono] フルページキャプチャに失敗しました', error);
    }
  } finally {
    if (!succeeded) {
      // キャンセル・エラー時のみ後始末する。成功時はresult.html側が読み出し後に削除する。
      await deleteSession(captureId).catch(() => {});
    }
    if (original) {
      await chrome.scripting
        .executeScript({ target: { tabId }, func: restorePage, args: [original] })
        .catch((error) => console.error('[makimono] ページ状態の復元に失敗しました', error));
    }
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
