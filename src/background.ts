import {
  prepareAndMeasure,
  scrollAndSettle,
  restorePage,
  prepareOverlay,
  hideOverlay,
  showOverlayProgress,
  hideFixedElements,
  showToast,
} from './lib/inject';
import { computeScrollSteps } from './lib/geometry';
import { appendSegment, saveSessionMeta, deleteSession, purgeStaleCaptures } from './lib/db';
import { loadSettings, effectiveCaptureDelay } from './lib/settings';
import { t, LocalizedError } from './lib/i18n';
import { getBlockReason, blockReasonMessageKey, isFileUrl } from './lib/url-guard';

// エラーを知らせるバッジ。放置されないよう、次のクリックと一定時間後に消す
const ERROR_BADGE = '!';
const ERROR_BADGE_CLEAR_MS = 10_000;
const ERROR_BADGE_COLOR = '#a33';
const PROGRESS_BADGE_COLOR = '#3a352f';

// 高さの計測値が壊れているページ（仮想スクロールのスペーサー等）で際限なく
// 撮り続けないための上限。受け入れ基準の3万pxに対して十分な余裕がある。
const MAX_SEGMENTS = 200;

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

// エラーバッジ消去の予約。タブごとに1つだけ保持し、張り替え時と手動クリア時に止める
const errorBadgeTimers = new Map<number, ReturnType<typeof setTimeout>>();

// クォータはブラウザ全体で共有のため、レート制限の計測もキャプチャ実行をまたいで共有する
// （複数ウィンドウで並行キャプチャしたときに間隔が半分にならないように）。
// 待機と撮影の間に割り込みが入りうるため厳密な排他ではない。取りこぼしはリトライで吸収する。
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
    console.error('[utsushi] tab.id または windowId が取得できませんでした');
    return;
  }
  const tabId = tab.id;

  // FR-05: キャプチャ中の再クリックはキャンセルとして扱う
  const existing = runningCaptures.get(tabId);
  if (existing) {
    existing.cancelled = true;
    return;
  }

  await clearErrorBadge(tabId);

  // §8.1: 撮影できないページは開始せず理由を知らせる
  const blockReason = getBlockReason(tab.url);
  if (blockReason) {
    await reportError(tabId, t(blockReasonMessageKey(blockReason)));
    return;
  }

  const state: CaptureState = { cancelled: false };
  runningCaptures.set(tabId, state);
  try {
    await runCapture(tabId, tab.windowId, state, toPageInfo(tab), tab.url);
  } finally {
    // 成功・失敗・キャンセルのいずれでも必ず解放する。
    // 残すと次のクリックが「新規撮影」でなく「キャンセル」と誤認され、再撮影できなくなる。
    runningCaptures.delete(tabId);
  }
}

/**
 * 失敗を利用者に伝える。
 * バッジとツールチップは常に出す（撮影できないページでは中に入れないため、これが唯一の手段）。
 * ページ内へ入れる場合はトーストも出す。
 */
async function reportError(tabId: number, message: string): Promise<void> {
  console.error('[utsushi]', message);

  await chrome.action.setBadgeText({ tabId, text: ERROR_BADGE }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: ERROR_BADGE_COLOR }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: `${t('extName')}: ${message}` }).catch(() => {});

  await chrome.scripting
    .executeScript({ target: { tabId }, func: showToast, args: [message] })
    .catch(() => {
      // chrome:// など注入できないページ。バッジとツールチップだけで伝える
    });

  // SWが先に終了した場合はバッジが残るが、次のクリックでも消える
  const previous = errorBadgeTimers.get(tabId);
  if (previous !== undefined) clearTimeout(previous);
  errorBadgeTimers.set(
    tabId,
    setTimeout(() => {
      errorBadgeTimers.delete(tabId);
      void clearErrorBadge(tabId);
    }, ERROR_BADGE_CLEAR_MS),
  );
}

async function clearErrorBadge(tabId: number): Promise<void> {
  // 前回のタイマーを必ず止める。放置すると、次の撮影の進捗バッジを途中で消してしまう
  const timer = errorBadgeTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    errorBadgeTimers.delete(tabId);
  }
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: '' }).catch(() => {});
}

async function runCapture(
  tabId: number,
  windowId: number,
  state: CaptureState,
  pageInfo: PageInfo,
  tabUrl: string | undefined,
): Promise<void> {
  const captureId = crypto.randomUUID();
  const capturedAt = Date.now();
  let original: { scrollX: number; scrollY: number } | null = null;
  let injected = false;
  let succeeded = false;
  let failureMessage: string | null = null;

  activeCaptureIds.add(captureId);
  try {
    const settings = await loadSettings();
    const captureIntervalMs = effectiveCaptureDelay(settings);

    injected = true; // ここから先はページに注入物が残りうるため、finallyで必ず復元を試みる
    const [measurementInjection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: prepareAndMeasure,
      args: [settings.preScroll, captureId],
    });
    const measurement = measurementInjection?.result;
    if (!measurement) {
      throw new Error('ページの測定に失敗しました');
    }
    original = measurement.original;

    const steps = computeScrollSteps(measurement.totalHeightCss, measurement.viewportHeightCss);
    if (steps.length > MAX_SEGMENTS) {
      throw new LocalizedError('errorPageTooTall', `too many segments: ${steps.length}`);
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      func: prepareOverlay,
      args: [captureId, t('overlayProgress', ['0'])],
    });
    await chrome.action
      .setBadgeBackgroundColor({ tabId, color: PROGRESS_BADGE_COLOR })
      .catch(() => {});

    const actualStepsCss: number[] = [];

    for (let i = 0; i < steps.length; i++) {
      if (state.cancelled) {
        throw new CaptureCancelledError();
      }

      if (settings.hideFixedElements && i >= 1) {
        // FR-03: 1枚目には固定要素を写し、2枚目以降では隠す。
        // 冪等なので毎ステップ呼び、撮影中に出現した固定要素（遅延バナー等）も拾う。
        await chrome.scripting.executeScript({
          target: { tabId },
          func: hideFixedElements,
          args: [captureId],
        });
      }

      const [settledInjection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollAndSettle,
        args: [steps[i]],
      });
      const settled = settledInjection?.result;
      if (!settled) {
        throw new Error(`スクロールの実行に失敗しました（step ${i}）`);
      }
      if (!settled.visible) {
        throw new LocalizedError('errorTabChanged', 'tab became hidden');
      }
      actualStepsCss.push(settled.scrollY);

      // FR-05: キャプチャの瞬間はオーバーレイを必ず非表示にする（描画反映まで待つ）
      await chrome.scripting.executeScript({
        target: { tabId },
        func: hideOverlay,
        args: [captureId],
      });

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
        throw new LocalizedError('errorTabChanged', 'tab is no longer in front');
      }

      const dataUrl = await captureWithRetry(windowId, captureIntervalMs);
      await appendSegment(captureId, i, dataUrl);

      const percent = Math.round(((i + 1) / steps.length) * 100);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: showOverlayProgress,
        args: [captureId, t('overlayProgress', [String(percent)])],
      });
      await chrome.action.setBadgeText({ tabId, text: `${percent}%` }).catch(() => {});
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
      console.log('[utsushi] キャプチャをキャンセルしました');
    } else {
      console.error('[utsushi] 全ページキャプチャに失敗しました', error);
      failureMessage = describeFailure(error, tabUrl);
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
        .executeScript({ target: { tabId }, func: restorePage, args: [original, captureId] })
        .catch((error) => console.error('[utsushi] ページ状態の復元に失敗しました', error));
    }
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});

    // 復元まで終えてから知らせる（トーストは復元処理で消されないよう最後に出す）
    if (failureMessage) {
      await reportError(tabId, failureMessage);
    }
  }
}

/** 例外を、利用者に見せる文言へ変換する。内部エラーの文面はそのまま出さない。 */
function describeFailure(error: unknown, tabUrl: string | undefined): string {
  if (error instanceof LocalizedError) {
    return t(error.messageKey);
  }
  // 注入自体が拒否される代表例。file:// は「ファイルのURLへのアクセスを許可する」が未設定だと入れない
  if (isFileUrl(tabUrl)) {
    return t('errorBlockedFile');
  }
  return t('errorCaptureFailed');
}

function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
}

/**
 * §8.3: クォータ超過は指数バックオフで1回だけ再試行する。
 * それでも駄目なら、待機時間を延ばす案内につながる文言で投げる。
 */
async function captureWithRetry(windowId: number, intervalMs: number): Promise<string> {
  lastCaptureAt = Date.now();
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (error) {
    if (!isQuotaError(error)) throw error;

    console.warn('[utsushi] キャプチャのクォータを超過しました。待機して再試行します');
    await sleep(intervalMs * 2);

    lastCaptureAt = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (retryError) {
      if (isQuotaError(retryError)) {
        throw new LocalizedError('errorQuotaExceeded', 'capture quota exceeded after retry');
      }
      throw retryError;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
