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
import { appendSegment, saveSessionMeta, deleteSession, purgeStaleCaptures } from './lib/db';
import { loadSettings, effectiveCaptureDelay } from './lib/settings';
import { t } from './lib/i18n';

interface CaptureState {
  cancelled: boolean;
}

// ファイル名テンプレート用のページ情報。activeTab権限でtab.title/tab.urlが読めるため
// 追加権限は不要。URL全体は保持せずホスト名だけを取り出す。
interface PageInfo {
  title: string;
  host: string;
}

function toPageInfo(tab: chrome.tabs.Tab): PageInfo {
  let host = '';
  try {
    if (tab.url) host = new URL(tab.url).hostname;
  } catch {
    host = '';
  }
  return { title: tab.title ?? '', host };
}

const runningCaptures = new Map<number, CaptureState>();

// クォータはブラウザ全体で共有のため、レート制限の計測もキャプチャ実行をまたいで共有する
// （複数ウィンドウで並行キャプチャしても合算で制限内に収まるように）。
let lastCaptureAt = 0;

// SWがfinally到達前に殺された場合に残る古いデータの掃除（起動時1回）。
// 進行中キャプチャのIDは除外する。
const activeCaptureIds = new Set<string>();
void purgeStaleCaptures(activeCaptureIds).catch(() => {});

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
    await runCapture(tab.id, tab.windowId, state, toPageInfo(tab));
  } finally {
    // 成功・失敗・キャンセルのいずれでも必ず解放する。
    // 残すと次のクリックが「新規撮影」でなく「キャンセル」と誤認され、再撮影できなくなる。
    runningCaptures.delete(tab.id);
  }
}

async function runCapture(
  tabId: number,
  windowId: number,
  state: CaptureState,
  pageInfo: PageInfo,
): Promise<void> {
  const captureId = crypto.randomUUID();
  const capturedAt = Date.now();
  let original: { scrollX: number; scrollY: number } | null = null;
  let injected = false;
  let succeeded = false;

  activeCaptureIds.add(captureId);
  try {
    const settings = await loadSettings();
    const captureIntervalMs = effectiveCaptureDelay(settings);

    injected = true; // ここから先はページに注入物が残りうるため、finallyで必ず復元を試みる
    const [measurementInjection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: prepareAndMeasure,
      args: [settings.preScroll],
    });
    const measurement = measurementInjection.result;
    if (!measurement) {
      throw new Error('ページの測定に失敗しました');
    }
    original = measurement.original;

    const steps = computeScrollSteps(measurement.totalHeightCss, measurement.viewportHeightCss);

    await chrome.scripting.executeScript({
      target: { tabId },
      func: prepareOverlay,
      args: [t('overlayProgress', ['0'])],
    });

    const actualStepsCss: number[] = [];

    for (let i = 0; i < steps.length; i++) {
      if (state.cancelled) {
        throw new CaptureCancelledError();
      }

      if (settings.hideFixedElements && i >= 1) {
        // FR-03: 1枚目には固定要素を写し、2枚目以降では隠す。
        // 冪等なので毎ステップ呼び、撮影中に出現した固定要素（遅延バナー等）も拾う。
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
      if (!settled.visible) {
        throw new Error('タブが非表示になったため中断しました');
      }
      actualStepsCss.push(settled.scrollY);

      // FR-05: キャプチャの瞬間はオーバーレイを必ず非表示にする（描画反映まで待つ）
      await chrome.scripting.executeScript({ target: { tabId }, func: hideOverlay });

      // レート制限の下限保証：計測起点をcaptureVisibleTab直前に置くことで、
      // scrollAndSettle等がどれだけ時間を使っても実効間隔が縮まないようにする。
      const wait = captureIntervalMs - (Date.now() - lastCaptureAt);
      if (wait > 0) {
        await sleep(wait);
      }

      // captureVisibleTabは「ウィンドウの今アクティブなタブ」を撮るため、
      // 対象タブが前面でなくなっていたら、別タブの内容が混入する前に中断する。
      const currentTab = await chrome.tabs.get(tabId);
      if (!currentTab.active || currentTab.windowId !== windowId) {
        throw new Error('対象タブが前面でなくなったため中断しました');
      }

      lastCaptureAt = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      await appendSegment(captureId, i, dataUrl);

      const percent = Math.round(((i + 1) / steps.length) * 100);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: showOverlayProgress,
        args: [t('overlayProgress', [String(percent)])],
      });
      await chrome.action.setBadgeText({ tabId, text: `${percent}%` });
    }

    // 最終セグメント処理中のキャンセルを拾う（ここを抜けたら結果タブを開いてよい）
    if (state.cancelled) {
      throw new CaptureCancelledError();
    }

    await saveSessionMeta(captureId, {
      viewportWidthCss: measurement.viewportWidthCss,
      viewportHeightCss: measurement.viewportHeightCss,
      totalHeightCss: measurement.totalHeightCss,
      dpr: measurement.dpr,
      actualStepsCss,
      pageTitle: pageInfo.title,
      pageHost: pageInfo.host,
      capturedAt,
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
      console.error('[makimono] 全ページキャプチャに失敗しました', error);
    }
  } finally {
    if (!succeeded) {
      // キャンセル・エラー時のみ後始末する。成功時はresult.html側が読み出し後に削除する。
      await deleteSession(captureId).catch(() => {});
    }
    activeCaptureIds.delete(captureId);
    if (injected) {
      // originalがnullでも注入済みスタイル・属性の復元は必要（restorePage側がnullを許容する）
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
