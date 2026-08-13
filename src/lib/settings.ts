// FR-09: オプションの型・既定値・chrome.storage.sync への読み書き。
// 既定値はここが唯一の出所。参照側は必ずloadSettings()を通す。

export type ImageFormat = 'png' | 'jpeg';
export type PdfPaper = 'image' | 'a4';

export interface Settings {
  imageFormat: ImageFormat;
  jpegQuality: number;
  captureDelayMs: number;
  hideFixedElements: boolean;
  preScroll: boolean;
  pdfPaper: PdfPaper;
  filenameTemplate: string;
}

export const DEFAULT_SETTINGS: Settings = {
  imageFormat: 'png',
  jpegQuality: 0.92,
  captureDelayMs: 600,
  hideFixedElements: true,
  preScroll: false,
  pdfPaper: 'image',
  filenameTemplate: '{title}_{yyyyMMdd-HHmmss}',
};

export const LIMITS = {
  jpegQuality: { min: 0.5, max: 1 },
  // FR-02.4: captureVisibleTabのレート制限（約2回/秒）があるため、
  // 設定値がいくら小さくても実効下限500msを下回らせない
  captureDelayMs: { min: 200, max: 2000, effectiveMin: 500 },
} as const;

const STORAGE_KEY = 'settings';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 保存値は壊れている可能性があるため、型と範囲を検査して既定値で補う */
function normalize(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  return {
    imageFormat: input.imageFormat === 'jpeg' ? 'jpeg' : d.imageFormat,
    jpegQuality:
      typeof input.jpegQuality === 'number' && Number.isFinite(input.jpegQuality)
        ? clamp(input.jpegQuality, LIMITS.jpegQuality.min, LIMITS.jpegQuality.max)
        : d.jpegQuality,
    captureDelayMs:
      typeof input.captureDelayMs === 'number' && Number.isFinite(input.captureDelayMs)
        ? Math.round(clamp(input.captureDelayMs, LIMITS.captureDelayMs.min, LIMITS.captureDelayMs.max))
        : d.captureDelayMs,
    hideFixedElements:
      typeof input.hideFixedElements === 'boolean' ? input.hideFixedElements : d.hideFixedElements,
    preScroll: typeof input.preScroll === 'boolean' ? input.preScroll : d.preScroll,
    pdfPaper: input.pdfPaper === 'a4' ? 'a4' : d.pdfPaper,
    filenameTemplate:
      typeof input.filenameTemplate === 'string' && input.filenameTemplate.trim().length > 0
        ? input.filenameTemplate
        : d.filenameTemplate,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    return normalize(stored[STORAGE_KEY]);
  } catch (error) {
    // 設定が読めなくても撮影自体は続けられるべきなので既定値で進む
    console.error('[utsushi] 設定の読み込みに失敗しました', error);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: normalize(settings) });
}

export async function resetSettings(): Promise<void> {
  await chrome.storage.sync.remove(STORAGE_KEY);
}

/** レート制限を守るための実効待機時間 */
export function effectiveCaptureDelay(settings: Settings): number {
  return Math.max(LIMITS.captureDelayMs.effectiveMin, settings.captureDelayMs);
}
