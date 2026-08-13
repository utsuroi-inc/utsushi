import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  resetSettings,
  type ImageFormat,
  type PdfPaper,
  type Settings,
} from './lib/settings';
import { buildFilename } from './lib/filename';
import { t, applyI18n } from './lib/i18n';

const fields = {
  captureDelay: document.getElementById('captureDelay') as HTMLInputElement,
  captureDelayValue: document.getElementById('captureDelayValue'),
  hideFixedElements: document.getElementById('hideFixedElements') as HTMLInputElement,
  preScroll: document.getElementById('preScroll') as HTMLInputElement,
  imageFormat: document.getElementById('imageFormat') as HTMLSelectElement,
  jpegQuality: document.getElementById('jpegQuality') as HTMLInputElement,
  jpegQualityValue: document.getElementById('jpegQualityValue'),
  pdfPaper: document.getElementById('pdfPaper') as HTMLSelectElement,
  filenameTemplate: document.getElementById('filenameTemplate') as HTMLInputElement,
  filenamePreview: document.getElementById('filenamePreview'),
  reset: document.getElementById('reset') as HTMLButtonElement,
  saved: document.getElementById('saved'),
  licenses: document.getElementById('licenses') as HTMLAnchorElement | null,
};

let savedTimer: number | undefined;

applyI18n();
void init();

async function init(): Promise<void> {
  if (fields.licenses) {
    fields.licenses.href = chrome.runtime.getURL('licenses/README.md');
  }
  applyToForm(await loadSettings());

  for (const input of [
    fields.captureDelay,
    fields.hideFixedElements,
    fields.preScroll,
    fields.imageFormat,
    fields.jpegQuality,
    fields.pdfPaper,
    fields.filenameTemplate,
  ]) {
    input.addEventListener('input', () => {
      refreshLabels();
      void persist();
    });
  }

  fields.reset.addEventListener('click', () => {
    void (async () => {
      await resetSettings();
      applyToForm({ ...DEFAULT_SETTINGS });
      notifySaved();
    })();
  });
}

function applyToForm(settings: Settings): void {
  fields.captureDelay.value = String(settings.captureDelayMs);
  fields.hideFixedElements.checked = settings.hideFixedElements;
  fields.preScroll.checked = settings.preScroll;
  fields.imageFormat.value = settings.imageFormat;
  fields.jpegQuality.value = String(settings.jpegQuality);
  fields.pdfPaper.value = settings.pdfPaper;
  fields.filenameTemplate.value = settings.filenameTemplate;
  refreshLabels();
}

function readForm(): Settings {
  return {
    captureDelayMs: Number(fields.captureDelay.value),
    hideFixedElements: fields.hideFixedElements.checked,
    preScroll: fields.preScroll.checked,
    imageFormat: fields.imageFormat.value as ImageFormat,
    jpegQuality: Number(fields.jpegQuality.value),
    pdfPaper: fields.pdfPaper.value as PdfPaper,
    filenameTemplate: fields.filenameTemplate.value,
  };
}

function refreshLabels(): void {
  const settings = readForm();

  if (fields.captureDelayValue) {
    fields.captureDelayValue.textContent = `${settings.captureDelayMs} ${t('unitMs')}`;
  }
  if (fields.jpegQualityValue) {
    fields.jpegQualityValue.textContent = settings.jpegQuality.toFixed(2);
  }
  if (fields.filenamePreview) {
    // 実際の書き出しと同じ関数でプレビューを作る（サニタイズ結果まで見えるように）
    const example = buildFilename(
      settings.filenameTemplate,
      { title: t('extName'), urlHost: 'example.com', date: new Date() },
      settings.imageFormat === 'jpeg' ? 'jpg' : 'png',
    );
    fields.filenamePreview.textContent = t('optionsFilenamePreview', [example]);
  }
}

async function persist(): Promise<void> {
  await saveSettings(readForm());
  notifySaved();
}

function notifySaved(): void {
  if (!fields.saved) return;
  fields.saved.classList.add('visible');
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => {
    fields.saved?.classList.remove('visible');
  }, 1200);
}
