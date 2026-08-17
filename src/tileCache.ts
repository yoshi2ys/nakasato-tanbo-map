import { AJAXError, MercatorCoordinate, addProtocol } from 'maplibre-gl';

/**
 * 写真タイルを IndexedDB にためて、電波の届かない田んぼでも地図を出せるようにする。
 *
 * 保存するのは Blob ではなく ArrayBuffer。Safari は `file://` で開いたページから
 * Blob を IndexedDB に入れられず、書き込みがそこで失敗する。
 *
 * ためたタイルは期限で消えない。航空写真は年に一度あるかどうかの更新なので、
 * 古い写真が出続けるより、圏外で写真が出ないほうが困る。溜まった分はパネルに
 * 枚数と大きさで出し、「消す」で捨てられるようにしてある。
 */

const DB_NAME = 'tanbo-tiles';
const DB_VERSION = 2;
const STORE = 'tiles';
/**
 * 枚数と合計サイズの控え。全件を読んで数えると、ためた量に比例して起動が遅くなる。
 * 別のタブが書いた分はこのタブに伝わらないが、現地で 1 つ開いて使う道具なので割り切る。
 */
const TOTALS_STORE = 'totals';
const TOTALS_KEY = 'totals';

/** タイル URL の前に付ける独自プロトコル。maplibre はこれを見てこちらの取得処理を呼ぶ。 */
const PROTOCOL = 'tanbo';

/** 一度に投げる取得の数。相手は公共のタイルサーバなので、控えめにする。 */
const SAVE_CONCURRENCY = 4;

/** 保存するとき、表示中のズームより下に何段ぶん含めるか。 */
const ZOOM_OUT_MARGIN = 3;

/** 1 回の保存で許すタイル数。これを超える範囲は、時間も保存領域も現実的でない。 */
export const SAVE_TILE_LIMIT = 3000;

/** ためたタイルの読み書き先。開けなければ null（キャッシュなしで地図は動く）。 */
let database: Promise<IDBDatabase | null> | null = null;
/** 控えの現在値。読み出すたびに IndexedDB へ行かないよう、開いたあとはここで持つ。 */
let totals: CacheStats | null = null;

export interface TileSource {
  /** `{z}` `{x}` `{y}` を含むタイル URL。 */
  url: string;
  maxZoom: number;
  /** タイル 1 枚の画素数。表示に使われるズームの計算に要る。 */
  tileSize: number;
  /** y 軸が反転した TMS 方式か。 */
  tms?: boolean;
  /** 配信範囲 [西, 南, 東, 北]。外のタイルは数えない。 */
  bounds?: [number, number, number, number];
}

export interface CacheStats {
  count: number;
  bytes: number;
}

interface StoredTile {
  body: ArrayBuffer;
  type: string;
}

/** 地図のソースに渡す URL。maplibre 経由の取得をこのモジュールに通す。 */
export function cachedTileUrl(url: string): string {
  return `${PROTOCOL}://${url}`;
}

function openDatabase(): Promise<IDBDatabase | null> {
  database ??= new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Cookie を全面ブロックしていると open 自体が投げる。
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(TOTALS_STORE)) {
        db.createObjectStore(TOTALS_STORE);
        // 控えを持つ前にためた分があるので、ここで一度だけ数え直す。
        const transaction = request.transaction;
        if (transaction !== null) recountTotals(transaction);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return database;
}

/** IndexedDB を開いて操作する。開けないときと失敗したときは fallback を返す。 */
async function withDatabase<T>(fallback: T, run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDatabase();
  if (db === null) return fallback;
  try {
    return await run(db);
  } catch {
    return fallback;
  }
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error('IndexedDB の操作に失敗しました'));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('書き込みに失敗しました'));
    transaction.onabort = () => reject(transaction.error ?? new Error('書き込みを中断しました'));
  });
}

/** 枚数と合計サイズを数え直して控えに書く。ストアを作った直後にだけ通る。 */
function recountTotals(transaction: IDBTransaction): void {
  const counted: CacheStats = { count: 0, bytes: 0 };
  const cursor = transaction.objectStore(STORE).openCursor();
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (current === null) {
      transaction.objectStore(TOTALS_STORE).put(counted, TOTALS_KEY);
      return;
    }
    const tile = current.value as StoredTile;
    counted.count += 1;
    counted.bytes += tile.body.byteLength;
    current.continue();
  };
}

function readTile(url: string): Promise<StoredTile | null> {
  return withDatabase<StoredTile | null>(null, async (db) => {
    const stored = await request<StoredTile | undefined>(
      db.transaction(STORE).objectStore(STORE).get(url)
    );
    return stored ?? null;
  });
}

/** 中身まで読まずに、持っているかどうかだけ見る。 */
function hasTile(url: string): Promise<boolean> {
  return withDatabase(false, async (db) => {
    const key = await request(db.transaction(STORE).objectStore(STORE).getKey(url));
    return key !== undefined;
  });
}

/** ためられたら true。保存領域が一杯のときと、IndexedDB を開けないときは false。 */
function storeTile(url: string, tile: StoredTile): Promise<boolean> {
  return withDatabase(false, async (db) => {
    const transaction = db.transaction([STORE, TOTALS_STORE], 'readwrite');
    const tiles = transaction.objectStore(STORE);
    // 同じ URL を二重に数えない。取得は基本 1 回だが、表示と保存が同時に走ることはある。
    const known = (await request(tiles.getKey(url))) !== undefined;
    tiles.put(tile, url);

    if (!known) {
      const current = await readTotals(transaction);
      const next: CacheStats = {
        count: current.count + 1,
        bytes: current.bytes + tile.body.byteLength,
      };
      transaction.objectStore(TOTALS_STORE).put(next, TOTALS_KEY);
      totals = next;
    }

    await completed(transaction);
    return true;
  });
}

async function readTotals(transaction: IDBTransaction): Promise<CacheStats> {
  totals ??= (await request<CacheStats | undefined>(
    transaction.objectStore(TOTALS_STORE).get(TOTALS_KEY)
  )) ?? { count: 0, bytes: 0 };
  return totals;
}

/** タイルを取ってくる。ためるかどうかは呼び出し側が決める。 */
async function fetchTile(url: string, signal?: AbortSignal): Promise<StoredTile> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    // 市域外の 404 は maplibre 側で「タイルなし」として扱われる。素の Error にすると
    // その判別ができず、下のレイヤーが透ける代わりにエラーとして扱われる。
    // 中身は誰も読まないので、body は捨てる。
    void response.body?.cancel();
    throw new AJAXError(response.status, response.statusText, url, new Blob());
  }
  return {
    body: await response.arrayBuffer(),
    type: response.headers.get('content-type') ?? 'image/jpeg',
  };
}

/** ためたタイルを地図に使わせる。起動時に一度だけ呼ぶ。 */
export function installTileCache(): void {
  addProtocol(PROTOCOL, async (parameters, abortController) => {
    const url = parameters.url.slice(`${PROTOCOL}://`.length);
    const stored = await readTile(url);
    if (stored !== null) return { data: stored.body };

    const tile = await fetchTile(url, abortController.signal);
    // 描画は保存の完了を待たない。待たせるとタイル 1 枚ごとに書き込みぶん遅くなる。
    void storeTile(url, tile);
    return { data: tile.body };
  });
}

/** ためた枚数と大きさ。 */
export function cacheStats(): Promise<CacheStats> {
  if (totals !== null) return Promise.resolve(totals);
  return withDatabase({ count: 0, bytes: 0 }, (db) =>
    readTotals(db.transaction(TOTALS_STORE))
  );
}

/** ためたタイルをすべて捨てる。 */
export function clearTiles(): Promise<boolean> {
  return withDatabase(false, async (db) => {
    const transaction = db.transaction([STORE, TOTALS_STORE], 'readwrite');
    transaction.objectStore(STORE).clear();
    transaction.objectStore(TOTALS_STORE).put({ count: 0, bytes: 0 }, TOTALS_KEY);
    await completed(transaction);
    totals = { count: 0, bytes: 0 };
    return true;
  });
}

/**
 * 地図のズームに対して、実際に取りに行かれるタイルのズーム。
 *
 * maplibre は 512px を基準に数えるので、256px のタイルでは 1 段深いものを要求する
 * （地図が z17 なら z18 のタイル）。地図のズームでためると、現地では常に 1 段粗い
 * 引き伸ばしになる。
 */
function tileZoom(zoom: number, tileSize: number): number {
  return Math.round(zoom + Math.log2(512 / tileSize));
}

/**
 * 表示中の範囲を覆うタイルの URL。
 *
 * 少しズームを引いても写真が出るよう、表示中のズームより下も何段か含める。
 * 下のズームは枚数が 1/4 ずつ減るので、増えるのは全体の数パーセントに収まる。
 */
export function tileUrlsForView(
  sources: TileSource[],
  bounds: [west: number, south: number, east: number, north: number],
  zoom: number
): string[] {
  const [west, south, east, north] = bounds;
  const urls: string[] = [];

  for (const source of sources) {
    const limit = source.bounds;
    const covered =
      limit === undefined ||
      (west <= limit[2] && east >= limit[0] && south <= limit[3] && north >= limit[1]);
    if (!covered) continue;

    const top = Math.min(tileZoom(zoom, source.tileSize), source.maxZoom);
    for (let z = Math.max(0, top - ZOOM_OUT_MARGIN); z <= top; z += 1) {
      const count = 2 ** z;
      const clamp = (value: number): number => Math.min(count - 1, Math.max(0, Math.floor(value)));
      // 配信範囲の外は取りに行っても 404 になるだけなので、先に切っておく。
      const corner = (lng: number, lat: number): MercatorCoordinate =>
        MercatorCoordinate.fromLngLat({ lng, lat });
      const northWest = corner(Math.max(west, limit?.[0] ?? -180), Math.min(north, limit?.[3] ?? 85));
      const southEast = corner(Math.min(east, limit?.[2] ?? 180), Math.max(south, limit?.[1] ?? -85));

      const [minX, maxX] = [clamp(northWest.x * count), clamp(southEast.x * count)];
      const [minY, maxY] = [clamp(northWest.y * count), clamp(southEast.y * count)];

      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const tileY = source.tms === true ? count - 1 - y : y;
          urls.push(
            source.url
              .replace('{z}', String(z))
              .replace('{x}', String(x))
              .replace('{y}', String(tileY))
          );
        }
      }
    }
  }
  return urls;
}

export interface SaveResult {
  /** 取れなかった枚数。市域外の 404 もここに入る。 */
  failed: number;
  /** 取れたのに、ためられなかった枚数。保存領域が一杯のときに出る。 */
  notStored: number;
}

/**
 * タイルをためる。すでに持っているものは飛ばす。
 *
 * 進捗は 1 枚ごとに返す。数百枚を数分かけて取るので、途中経過が出ないと固まって見える。
 */
export async function saveTiles(
  urls: string[],
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<SaveResult> {
  const result: SaveResult = { failed: 0, notStored: 0 };
  let done = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < urls.length) {
      if (signal?.aborted === true) return;
      const url = urls[next++];
      if (url === undefined) return;

      if (!(await hasTile(url))) {
        try {
          // 取れてもためられていないなら、保存できたとは言わない。
          const tile = await fetchTile(url, signal);
          if (!(await storeTile(url, tile))) result.notStored += 1;
        } catch {
          result.failed += 1;
        }
      }
      onProgress((done += 1), urls.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SAVE_CONCURRENCY, urls.length) }, () => worker())
  );
  return result;
}
