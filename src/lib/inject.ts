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
//   スタイル要素ID:        'makimono-scroll-reset'
//   オーバーレイ要素ID:    'makimono-progress-overlay'
//   visibility退避属性:    'data-makimono-hidden'
//   loading退避属性:       'data-makimono-loading'

export interface Measurement {
  original: { scrollX: number; scrollY: number };
  totalHeightCss: number;
  viewportWidthCss: number;
  viewportHeightCss: number;
  dpr: number;
}

export async function prepareAndMeasure(): Promise<Measurement> {
  const STYLE_ID = 'makimono-scroll-reset';
  const LOADING_ATTR = 'data-makimono-loading';
  const DECODE_TIMEOUT_MS = 3000;
  const original = { scrollX: window.scrollX, scrollY: window.scrollY };

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // smoothスクロールとscroll-snapはどちらも「指定位置に着地しない」原因になるため撮影中は無効化する
    style.textContent = '* { scroll-behavior: auto !important; scroll-snap-type: none !important; }';
    document.documentElement.appendChild(style);
  }

  // FR-04: lazy画像をeagerに切り替えてデコードを待つ。高さ計測より先に行うことで、
  // デコードによるレイアウトシフトを計測に反映させる。
  // 取得が終わらない画像が1枚でもあると全体が固まるため、1枚ごとにタイムアウトと競わせる。
  // 元のloading値は属性に退避し、restorePageで戻す。
  const lazyImages = Array.from(
    document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]'),
  );
  await Promise.all(
    lazyImages.map((img) => {
      if (!img.hasAttribute(LOADING_ATTR)) {
        img.setAttribute(LOADING_ATTR, img.getAttribute('loading') ?? '');
      }
      img.loading = 'eager';
      return Promise.race([
        img.decode().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, DECODE_TIMEOUT_MS)),
      ]);
    }),
  );

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

export function prepareOverlay(): void {
  const OVERLAY_ID = 'makimono-progress-overlay';
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.textContent = '巻物 0%';
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
  const OVERLAY_ID = 'makimono-progress-overlay';
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

export function showOverlayProgress(percent: number): void {
  const OVERLAY_ID = 'makimono-progress-overlay';
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.textContent = `巻物 ${percent}%`;
  overlay.style.visibility = 'visible';
}

// FR-03: 2枚目以降のセグメントに固定要素が重複して写らないよう隠す（1枚目には写す）。
// 冪等（退避済み要素はスキップ）なので、撮影中に出現した固定要素を拾うため毎ステップ呼んでよい。
export function hideFixedElements(): void {
  const OVERLAY_ID = 'makimono-progress-overlay';
  const HIDDEN_ATTR = 'data-makimono-hidden';
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
  const STYLE_ID = 'makimono-scroll-reset';
  const OVERLAY_ID = 'makimono-progress-overlay';
  const HIDDEN_ATTR = 'data-makimono-hidden';
  const LOADING_ATTR = 'data-makimono-loading';

  try {
    document.getElementById(STYLE_ID)?.remove();
  } catch (e) {
    console.error('[makimono] スタイル要素の削除に失敗しました', e);
  }

  try {
    document.getElementById(OVERLAY_ID)?.remove();
  } catch (e) {
    console.error('[makimono] オーバーレイの削除に失敗しました', e);
  }

  try {
    document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach((el) => {
      el.style.visibility = el.getAttribute(HIDDEN_ATTR) ?? '';
      el.removeAttribute(HIDDEN_ATTR);
    });
  } catch (e) {
    console.error('[makimono] 固定要素の可視性復元に失敗しました', e);
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
    console.error('[makimono] 画像loading属性の復元に失敗しました', e);
  }

  try {
    if (original) {
      window.scrollTo({ top: original.scrollY, left: original.scrollX, behavior: 'instant' });
    }
  } catch (e) {
    console.error('[makimono] スクロール位置の復元に失敗しました', e);
  }
}
