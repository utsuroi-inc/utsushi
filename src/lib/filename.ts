// ファイル名テンプレートの置換とサニタイズ（DOM非依存の純粋関数）。
//
// 方針：日本語はそのまま残す（ASCII化・URLエンコードはしない）。
// 落とすのはOSがファイル名として受け付けない文字だけに限る。

const FORBIDDEN_CHARS = /[\\/:*?"<>|]/g;
// 制御文字（U+0000-U+001F, U+007F）。ファイル名に混入すると環境によって壊れる
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');
const WHITESPACE_RUNS = /\s+/g;
const TRAILING_DOTS_SPACES = /[. ]+$/;
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

const FALLBACK_NAME = 'makimono';
const TITLE_MAX_CODE_POINTS = 60;
const TITLE_MAX_BYTES = 150;
const FILENAME_MAX_BYTES = 200;

export interface FilenameTokens {
  title: string;
  urlHost: string;
  date: Date;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ローカル時刻で yyyyMMdd-HHmmss */
export function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * コードポイント単位で切り詰める。UTF-16のコードユニットで切るとサロゲートペア
 * （絵文字など）が割れて壊れた文字になるため、Array.fromで分割してから詰める。
 */
export function truncateByCodePoints(text: string, maxCodePoints: number, maxBytes: number): string {
  let codePoints = Array.from(text).slice(0, maxCodePoints);
  while (codePoints.length > 0 && utf8Length(codePoints.join('')) > maxBytes) {
    codePoints.pop();
  }
  return codePoints.join('');
}

/** OSがファイル名に使えない要素を取り除く。日本語などの文字はそのまま残す。 */
export function sanitizeFilename(raw: string): string {
  let name = raw
    .replace(CONTROL_CHARS, ' ')
    .replace(FORBIDDEN_CHARS, '_')
    .replace(WHITESPACE_RUNS, ' ')
    .trim();

  // Windowsは末尾のドット・空白を黙って落とすため、こちらで先に落として齟齬をなくす
  name = name.replace(TRAILING_DOTS_SPACES, '');
  // 先頭のドットはUnix系で隠しファイルになる
  if (name.startsWith('.')) {
    name = `_${name.slice(1)}`;
  }
  if (WINDOWS_RESERVED.test(name)) {
    name = `_${name}`;
  }
  return name;
}

/**
 * テンプレートを置換してファイル名を作る。
 * 置換 → サニタイズ → 長さガード → 拡張子付与の順。
 *
 * @param template 例: '{title}_{yyyyMMdd-HHmmss}'
 * @param extension 先頭のドットを含まない拡張子（'png' 等）
 * @param suffix 分割時の連番など、拡張子の直前に付ける文字列（例: '_1of3'）
 */
export function buildFilename(
  template: string,
  tokens: FilenameTokens,
  extension: string,
  suffix = '',
): string {
  // タイトルは先に単体で切り詰める（長いタイトルが時刻を押し出さないように）
  const title = truncateByCodePoints(
    sanitizeFilename(tokens.title),
    TITLE_MAX_CODE_POINTS,
    TITLE_MAX_BYTES,
  );

  const replaced = template
    .replace(/\{title\}/g, title)
    .replace(/\{url_host\}/g, tokens.urlHost)
    .replace(/\{yyyyMMdd-HHmmss\}/g, formatTimestamp(tokens.date));

  let name = sanitizeFilename(replaced);
  if (name.length === 0) {
    name = FALLBACK_NAME;
  }

  // 連番と拡張子は必ず残したいので、切り詰めの対象から外して先に長さを確保する
  const tail = `${sanitizeFilename(suffix)}.${extension}`;
  name = truncateByCodePoints(name, Number.MAX_SAFE_INTEGER, FILENAME_MAX_BYTES - utf8Length(tail));
  // 切り詰めで末尾がドット・空白になった場合の再掃除
  name = name.replace(TRAILING_DOTS_SPACES, '');
  if (name.length === 0) {
    name = FALLBACK_NAME;
  }

  return `${name}${tail}`;
}
