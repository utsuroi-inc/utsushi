import { getCapture, deleteCapture } from './lib/db';

void main();

async function main(): Promise<void> {
  const captureId = new URLSearchParams(location.search).get('id');
  const img = document.getElementById('result-image') as HTMLImageElement | null;
  const message = document.getElementById('message');

  if (!captureId || !img) {
    showMessage(message, '画像IDが指定されていません。');
    return;
  }

  const dataUrl = await getCapture(captureId);
  if (!dataUrl) {
    showMessage(message, '画像が見つかりませんでした。もう一度撮影してください。');
    return;
  }

  img.src = dataUrl;
  await deleteCapture(captureId);
}

function showMessage(el: HTMLElement | null, text: string): void {
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
}
