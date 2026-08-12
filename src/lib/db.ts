// Service WorkerとResultページ間でキャプチャセグメントを受け渡すためのIndexedDBラッパー。
// §6.3の推奨方式：セグメントをキャプチャIDで保存し、result側が読み出して合成後に削除する。
//
// sessions: キャプチャ1回分のメタ情報（{id, meta}）
// segments: セグメント本体。keyPathを['captureId','index']の複合キーにすることで、
//           1セグメントごとにO(1)で追記でき、IDBKeyRangeでcaptureId単位の一括取得・削除ができる。
//
// 各トランザクションにはonerrorに加えonabortも張る。エラーイベントを伴わないabortで
// Promiseが永久未解決になると、呼び出し側のキャプチャループごと固まるため。

const DB_NAME = 'makimono';
const DB_VERSION = 2;
const SESSIONS_STORE = 'sessions';
const SEGMENTS_STORE = 'segments';

export interface SessionMeta {
  viewportWidthCss: number;
  viewportHeightCss: number;
  totalHeightCss: number;
  dpr: number;
  actualStepsCss: number[];
}

interface SessionRecord {
  id: string;
  meta: SessionMeta;
}

interface SegmentRecord {
  captureId: string;
  index: number;
  dataUrl: string;
}

function segmentRange(captureId: string): IDBKeyRange {
  return IDBKeyRange.bound([captureId, 0], [captureId, Number.MAX_SAFE_INTEGER]);
}

function abortError(tx: IDBTransaction): Error {
  return tx.error ?? new DOMException('トランザクションが中断されました', 'AbortError');
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // フェーズ0のスキーマ（単一dataURL）は使わなくなったため掃除する。unpacked配布のみで実データはない。
      if (db.objectStoreNames.contains('captures')) {
        db.deleteObjectStore('captures');
      }
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SEGMENTS_STORE)) {
        db.createObjectStore(SEGMENTS_STORE, { keyPath: ['captureId', 'index'] });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('DBが他の接続にブロックされています'));
  });
}

export async function appendSegment(captureId: string, index: number, dataUrl: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SEGMENTS_STORE, 'readwrite');
      const record: SegmentRecord = { captureId, index, dataUrl };
      tx.objectStore(SEGMENTS_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(abortError(tx));
    });
  } finally {
    db.close();
  }
}

export async function saveSessionMeta(captureId: string, meta: SessionMeta): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SESSIONS_STORE, 'readwrite');
      const record: SessionRecord = { id: captureId, meta };
      tx.objectStore(SESSIONS_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(abortError(tx));
    });
  } finally {
    db.close();
  }
}

export async function getSession(
  captureId: string,
): Promise<{ meta: SessionMeta; segments: string[] } | undefined> {
  const db = await openDb();
  try {
    const meta = await new Promise<SessionMeta | undefined>((resolve, reject) => {
      const tx = db.transaction(SESSIONS_STORE, 'readonly');
      const request = tx.objectStore(SESSIONS_STORE).get(captureId);
      request.onsuccess = () => resolve((request.result as SessionRecord | undefined)?.meta);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(abortError(tx));
    });
    if (!meta) return undefined;

    const segments = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(SEGMENTS_STORE, 'readonly');
      const request = tx.objectStore(SEGMENTS_STORE).getAll(segmentRange(captureId));
      request.onsuccess = () => {
        const records = request.result as SegmentRecord[];
        records.sort((a, b) => a.index - b.index);
        resolve(records.map((record) => record.dataUrl));
      };
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(abortError(tx));
    });

    return { meta, segments };
  } finally {
    db.close();
  }
}

export async function deleteSession(captureId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([SESSIONS_STORE, SEGMENTS_STORE], 'readwrite');
      tx.objectStore(SESSIONS_STORE).delete(captureId);
      tx.objectStore(SEGMENTS_STORE).delete(segmentRange(captureId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(abortError(tx));
    });
  } finally {
    db.close();
  }
}

// SWがfinally到達前に殺された場合（ブラウザ終了・拡張リロード等）に残る
// 古いセッション・セグメント（＝ページ内容の画像）を、SW起動時に掃除する。
// 進行中のキャプチャを誤って消さないよう、excludeに実行中のcaptureIdを渡す。
export async function purgeStaleCaptures(exclude: ReadonlySet<string>): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([SESSIONS_STORE, SEGMENTS_STORE], 'readwrite');
      const sessions = tx.objectStore(SESSIONS_STORE);
      const segments = tx.objectStore(SEGMENTS_STORE);

      const sessionKeysRequest = sessions.getAllKeys();
      sessionKeysRequest.onsuccess = () => {
        for (const key of sessionKeysRequest.result) {
          const id = String(key);
          if (!exclude.has(id)) {
            sessions.delete(id);
          }
        }
      };

      const cursorRequest = segments.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const record = cursor.value as SegmentRecord;
        if (!exclude.has(record.captureId)) {
          cursor.delete();
        }
        cursor.continue();
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(abortError(tx));
    });
  } finally {
    db.close();
  }
}
