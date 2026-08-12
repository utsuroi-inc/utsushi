// chrome.scripting.executeScript の func として注入する関数群。
//
// 重要な制約：これらの関数はシリアライズされてページの分離ワールドへ注入・実行される。
// 実行時にはこのモジュールのスコープ（import・トップレベルconst等）が失われるため、
// 各関数は自分の引数とWeb標準グローバルだけで完結させること。
// スタイルIDを外の定数として共有すると、ビルド・型検査は通るのに実行時だけ壊れる
// （原因が注入先ページのコンソールにしか出ない）ため、各関数内に文字列リテラルで直書きする。

export interface Measurement {
  original: { scrollX: number; scrollY: number };
  totalHeightCss: number;
  viewportWidthCss: number;
  viewportHeightCss: number;
  dpr: number;
}

export function prepareAndMeasure(): Measurement {
  const STYLE_ID = 'makimono-scroll-reset';
  const original = { scrollX: window.scrollX, scrollY: window.scrollY };

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '* { scroll-behavior: auto !important; }';
    document.documentElement.appendChild(style);
  }

  const totalHeightCss = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
    document.documentElement.offsetHeight,
    document.body ? document.body.offsetHeight : 0,
    document.documentElement.clientHeight,
  );

  return {
    original,
    totalHeightCss,
    viewportWidthCss: window.innerWidth,
    viewportHeightCss: window.innerHeight,
    dpr: window.devicePixelRatio,
  };
}

export function scrollAndSettle(y: number): Promise<{ scrollY: number }> {
  return new Promise((resolve) => {
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve({ scrollY: window.scrollY });
      });
    });
  });
}

export function restorePage(original: { scrollX: number; scrollY: number }): void {
  const STYLE_ID = 'makimono-scroll-reset';
  const style = document.getElementById(STYLE_ID);
  if (style) style.remove();
  window.scrollTo({ top: original.scrollY, left: original.scrollX, behavior: 'instant' });
}
