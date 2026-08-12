import { putCapture } from './lib/db';

chrome.action.onClicked.addListener((tab) => {
  void handleClick(tab);
});

async function handleClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.windowId === undefined) {
    console.error('[makimono] windowId が取得できませんでした');
    return;
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
    });

    const captureId = crypto.randomUUID();
    await putCapture(captureId, dataUrl);

    await chrome.tabs.create({
      url: chrome.runtime.getURL(`result.html?id=${captureId}`),
    });
  } catch (error) {
    // フェーズ0時点では最小限のログのみ。ユーザー向けの通知はフェーズ5で扱う。
    console.error('[makimono] キャプチャに失敗しました', error);
  }
}
