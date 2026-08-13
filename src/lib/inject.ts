// chrome.scripting.executeScript の func として注入する関数群。
//
// 重要な制約：これらの関数はシリアライズされてページの分離ワールドへ注入・実行される。
// 実行時にはこのモジュールのスコープ（import・トップレベルconst・他のトップレベル関数）が
// 失われるため、各関数は自分の引数とWeb標準グローバルだけで完結させること。
// ヘルパーが必要なら関数本体内にネストして定義する。定数を外に切り出すと
// ビルド・型検査は通るのに実行時だけ壊れる（エラーは注入先ページのコンソールにしか
// 出ない）ため、IDは各関数内に文字列リテラルで直書きする。
//
// 使用しているリテラル一覧（変更時は全関数を目視で突き合わせること）：
//   スタイル要素ID:        'utsushi-scroll-reset'
//   オーバーレイ要素ID:    'utsushi-progress-overlay'
//   トースト要素ID:        'utsushi-toast'（showToast と prepareAndMeasure が参照）
//   visibility退避属性:    'data-utsushi-hidden'
//   loading退避属性:       'data-utsushi-loading'

export interface Measurement {
  original: { scrollX: number; scrollY: number };
  totalHeightCss: number;
  viewportWidthCss: number;
  viewportHeightCss: number;
  dpr: number;
}

export async function prepareAndMeasure(preScroll: boolean): Promise<Measurement> {
  const STYLE_ID = 'utsushi-scroll-reset';
  const LOADING_ATTR = 'data-utsushi-loading';
  const DECODE_TIMEOUT_MS = 3000;
  const TOAST_ID = 'utsushi-toast';
  const PRE_SCROLL_MAX_STEPS = 300;
  const original = { scrollX: window.scrollX, scrollY: window.scrollY };

  // 直前の失敗トーストが残っていると1枚目に写り込むため、撮影開始時に必ず消す
  document.getElementById(TOAST_ID)?.remove();

  const measureHeight = (): number =>
    Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement.offsetHeight,
      document.body ? document.body.offsetHeight : 0,
      document.documentElement.clientHeight,
    );

  const nextFrames = (): Promise<void> =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // smoothスクロールとscroll-snapはどちらも「指定位置に着地しない」原因になるため撮影中は無効化する
    style.textContent = '* { scroll-behavior: auto !important; scroll-snap-type: none !important; }';
    document.documentElement.appendChild(style);
  }

  // FR-04: lazy画像をeagerに切り替える。元のloading値は属性に退避し、restorePageで戻す。
  const lazyImages = Array.from(document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]'));
  for (const img of lazyImages) {
    if (!img.hasAttribute(LOADING_ATTR)) {
      img.setAttribute(LOADING_ATTR, img.getAttribute('loading') ?? '');
    }
    img.loading = 'eager';
  }

  // FR-04（オプション）：先に一度ページ全体を流して、スクロール連動で読み込まれる画像を出させる。
  // 無限スクロールでページが伸び続ける場合に止まらなくなるため、上限回数で必ず抜ける。
  if (preScroll) {
    let y = 0;
    for (let i = 0; i < PRE_SCROLL_MAX_STEPS; i++) {
      const limit = Math.max(0, measureHeight() - window.innerHeight);
      if (y >= limit) break;
      y = Math.min(y + window.innerHeight, limit);
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      await nextFrames();
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await nextFrames();
  }

  // デコード完了を待ってから高さを測る（デコードによるレイアウトシフトを計測に反映させるため）。
  // 取得が終わらない画像が1枚でもあると全体が固まるため、1枚ごとにタイムアウトと競わせる。
  await Promise.all(
    lazyImages.map((img) =>
      Promise.race([
        img.decode().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, DECODE_TIMEOUT_MS)),
      ]),
    ),
  );

  return {
    original,
    totalHeightCss: measureHeight(),
    viewportWidthCss: window.innerWidth,
    viewportHeightCss: window.innerHeight,
    dpr: window.devicePixelRatio,
  };
}

// 描画反映は二重rAFで待つが、バックグラウンドタブではrAFが停止して永久に解決しなくなるため、
// タイムアウトで必ず戻す。呼び出し側は戻り値のvisibleを見て中断を判定する。
export function scrollAndSettle(y: number): Promise<{ scrollY: number; visible: boolean }> {
  return new Promise((resolve) => {
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ scrollY: window.scrollY, visible: document.visibilityState === 'visible' });
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(finish);
    });
    // バックグラウンドタブではタイマーも1秒粒度に間引かれるため余裕を持たせる
    setTimeout(finish, 1500);
  });
}

// 表示文言はService Worker側でchrome.i18nから引いて渡す（注入先では自前の文言を持たない）
export function prepareOverlay(label: string): void {
  const OVERLAY_ID = 'utsushi-progress-overlay';
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.textContent = label;
  overlay.style.cssText = [
    'position: fixed',
    'right: 16px',
    'bottom: 16px',
    'z-index: 2147483647',
    'padding: 8px 12px',
    'border-radius: 8px',
    'background: rgba(28, 26, 23, 0.85)',
    'color: #fafaf7',
    'font: 12px/1.4 system-ui, sans-serif',
    'pointer-events: none',
  ].join('; ');
  document.documentElement.appendChild(overlay);
}

// FR-05: キャプチャの瞬間はオーバーレイを必ず非表示にする。
// visibilityの変更が実際に描画へ反映されるまで待ってから戻る（scrollAndSettleと同じ二重rAF＋
// バックグラウンド時のタイムアウトフォールバック）。
// これを省くと、特にレート制限待ちが発生しない1枚目でオーバーレイが写り込む。
export function hideOverlay(): Promise<void> {
  const OVERLAY_ID = 'utsushi-progress-overlay';
  return new Promise((resolve) => {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.style.visibility = 'hidden';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(finish);
    });
    setTimeout(finish, 1500);
  });
}

export function showOverlayProgress(label: string): void {
  const OVERLAY_ID = 'utsushi-progress-overlay';
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.textContent = label;
  overlay.style.visibility = 'visible';
}

// §8.3: 失敗の理由をページ上に短く出す。notifications権限を増やさずに済ませるため、
// 通知APIではなく自前の小さなカードを使う。文言はService Worker側で解決して渡す。
// 復元処理より後に呼ぶこと（restorePageは自分の注入物を消すため）。
export function showToast(message: string): void {
  const TOAST_ID = 'utsushi-toast';
  const VISIBLE_MS = 6000;

  document.getElementById(TOAST_ID)?.remove();

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.textContent = message;
  toast.style.cssText = [
    'position: fixed',
    'right: 16px',
    'bottom: 16px',
    'z-index: 2147483647',
    'max-width: 320px',
    'padding: 12px 16px',
    'border-radius: 8px',
    'background: rgba(28, 26, 23, 0.92)',
    'color: #fafaf7',
    'font: 13px/1.5 system-ui, sans-serif',
    'box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3)',
    'pointer-events: none',
    'white-space: pre-wrap',
  ].join('; ');
  document.documentElement.appendChild(toast);

  setTimeout(() => {
    // 別の撮影で新しいトーストに差し替わっている場合は消さない
    const current = document.getElementById(TOAST_ID);
    if (current === toast) current.remove();
  }, VISIBLE_MS);
}

// FR-03: 2枚目以降のセグメントに固定要素が重複して写らないよう隠す（1枚目には写す）。
// 冪等（退避済み要素はスキップ）なので、撮影中に出現した固定要素を拾うため毎ステップ呼んでよい。
export function hideFixedElements(): void {
  const OVERLAY_ID = 'utsushi-progress-overlay';
  const HIDDEN_ATTR = 'data-utsushi-hidden';
  const overlay = document.getElementById(OVERLAY_ID);

  document.querySelectorAll<HTMLElement>('*').forEach((el) => {
    if (overlay && overlay.contains(el)) return; // 自前のオーバーレイ（子孫含む）は対象外
    if (el.hasAttribute(HIDDEN_ATTR)) return;

    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
    if (cs.position === 'sticky') {
      // インセット未指定のstickyはrelative相当で固定されない＝二重写りを起こさないため対象外
      const noInset =
        cs.top === 'auto' && cs.right === 'auto' && cs.bottom === 'auto' && cs.left === 'auto';
      if (noInset) return;
    }

    // 元のインライン値を保存してから隠す。復元時は保存値に戻す（決め打ちの'visible'にしない）
    el.setAttribute(HIDDEN_ATTR, el.style.visibility);
    el.style.visibility = 'hidden';
  });
}

// NFR-05: どこか1箇所の復元が失敗しても他の復元を道連れにしないよう、各処理を独立させる。
// originalがnull（測定に失敗した等）でも、注入済みのスタイル・属性の復元は常に行う。
export function restorePage(original: { scrollX: number; scrollY: number } | null): void {
  const STYLE_ID = 'utsushi-scroll-reset';
  const OVERLAY_ID = 'utsushi-progress-overlay';
  const HIDDEN_ATTR = 'data-utsushi-hidden';
  const LOADING_ATTR = 'data-utsushi-loading';

  try {
    document.getElementById(STYLE_ID)?.remove();
  } catch (e) {
    console.error('[utsushi] スタイル要素の削除に失敗しました', e);
  }

  try {
    document.getElementById(OVERLAY_ID)?.remove();
  } catch (e) {
    console.error('[utsushi] オーバーレイの削除に失敗しました', e);
  }

  try {
    document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach((el) => {
      el.style.visibility = el.getAttribute(HIDDEN_ATTR) ?? '';
      el.removeAttribute(HIDDEN_ATTR);
    });
  } catch (e) {
    console.error('[utsushi] 固定要素の可視性復元に失敗しました', e);
  }

  try {
    document.querySelectorAll<HTMLImageElement>(`img[${LOADING_ATTR}]`).forEach((img) => {
      const saved = img.getAttribute(LOADING_ATTR);
      if (saved) {
        img.setAttribute('loading', saved);
      } else {
        img.removeAttribute('loading');
      }
      img.removeAttribute(LOADING_ATTR);
    });
  } catch (e) {
    console.error('[utsushi] 画像loading属性の復元に失敗しました', e);
  }

  try {
    if (original) {
      window.scrollTo({ top: original.scrollY, left: original.scrollX, behavior: 'instant' });
    }
  } catch (e) {
    console.error('[utsushi] スクロール位置の復元に失敗しました', e);
  }
}
