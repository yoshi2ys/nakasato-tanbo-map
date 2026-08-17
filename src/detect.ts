import opencvUrl from '@techstark/opencv-js/dist/opencv.js?url';
import type { Map as MapLibreMap, Point } from 'maplibre-gl';
import type { Vertex } from './geometry';

/** `@techstark/opencv-js` の名前空間。読み込みは script タグなので型だけ借りる。 */
type OpenCV = typeof import('@techstark/opencv-js');
type Mat = InstanceType<OpenCV['Mat']>;

/** 田んぼの色のばらつきをどこまで同じ面とみなすか（0〜255）。 */
const COLOR_TOLERANCE = 18;
/** フラッドフィルの連結性。斜めに繋がった 1px の隙間から漏れないよう 4 近傍にする。 */
const CONNECTIVITY = 4;
/**
 * 画像の細かさに関わる寸法は、ピクセルではなく地上距離で決める。
 * 画像ソースやズームが変わると 1px の地上距離は数倍変わるため、ピクセル固定だと
 * 「解像度を上げたら検出できなくなる」ことが起きる。
 */
/**
 * フラッドフィルの前にかける平滑化。稲の条間など、圃場内部の模様を消すための幅。
 *
 * 十日町市の航空写真（z20 まで）は条間まで写るので、ならさないと塗りが 1 枚を渡りきれない。
 * 一方これを大きくすると、粗い地理院タイルでは畦の輪郭まで消えて隣へ漏れやすくなる。
 * 既定の表示地点で実測して 2m とした（市の写真で 6/7、地理院タイルでも 5/5 検出）。
 */
const BLUR_METERS = 2;
/** ノイズを潰し、畦道の切れ目を埋めるモルフォロジーの幅。畦 1 本ぶんを見込む。 */
const MORPH_METERS = 3.3;
/** カーネルが大きくなりすぎると medianBlur が重いので上限を設ける。 */
const MAX_KERNEL_PIXELS = 15;
/** 間引き後に許す頂点数の上限。これを超えるあいだ epsilon を上げる。 */
const MAX_VERTICES = 15;
/** approxPolyDP の epsilon（周長に対する比）の探索範囲。 */
const EPSILON_RATIOS = [0.01, 0.015, 0.02, 0.03, 0.04];
/** 小さすぎ・大きすぎる検出は失敗とみなす（表示領域に対する面積比）。 */
const MIN_AREA_RATIO = 0.0005;
const MAX_AREA_RATIO = 0.6;
/** 描画の落ち着きを待つ上限。待てなくても撮って進む。 */
const IDLE_TIMEOUT_MS = 3000;

const NOT_FOUND = '輪郭を見つけられませんでした。別の場所をクリックしてください';

export class DetectionError extends Error {}

let opencv: Promise<OpenCV> | null = null;

/**
 * OpenCV.js は 13MB あるので、最初に自動検出を使うときまで読み込まない。
 *
 * ESM の `import()` は使えない。opencv.js は CommonJS で `module.exports` に Promise を
 * 入れており、CJS → ESM 変換でその `then` が名前付き export になる。すると `await import()`
 * が名前空間オブジェクト自体を thenable とみなして `Promise.prototype.then` を誤った
 * レシーバで呼び、production build だけが TypeError で落ちる。素の script なら変換を挟まない。
 */
export function loadOpenCV(): Promise<OpenCV> {
  opencv ??= new Promise<OpenCV>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = opencvUrl;
    script.onerror = () => reject(new DetectionError('OpenCV.js を読み込めませんでした'));
    script.onload = () => {
      // opencv.js は globalThis.cv に、初期化が終わると解決する Promise を置く。
      resolve((globalThis as unknown as { cv: OpenCV | Promise<OpenCV> }).cv);
    };
    document.head.append(script);
  }).catch((error: unknown) => {
    // 失敗を握ったままにすると、以後ずっと自動検出が使えなくなる。
    opencv = null;
    throw error;
  });
  return opencv;
}

/**
 * OpenCV.js は内部エラーを Error ではなく emscripten の例外ポインタ（数値）で投げる。
 * そのままだと console に整数が出るだけなので、読めるメッセージに直す。
 */
function toReadableError(cv: OpenCV, error: unknown): unknown {
  if (typeof error !== 'number') return error;
  const message = (cv as unknown as { exceptionFromPtr(ptr: number): { msg?: string } })
    .exceptionFromPtr(error).msg;
  return new Error(`OpenCV: ${message ?? error}`);
}

interface Capture {
  imageData: ImageData;
  /** CSS ピクセルに対する canvas の解像度倍率（Retina なら 2）。 */
  scale: number;
  /** 撮影した画像の 1 ピクセルが地上で何メートルか。 */
  metersPerPixel: number;
  /**
   * 撮影時のカメラと表示サイズ。緯度経度へ戻すときに、これらが変わっていないことを確かめる。
   * ウィンドウのリサイズは center も zoom も変えないまま unproject の結果を変えるので、
   * 画面サイズも一緒に見る必要がある。
   */
  camera: string;
  /** 切り出した左上（デバイス画素）。緯度経度へ戻すときに足し直す。 */
  origin: { x: number; y: number };
  /** 画面全体の画素数。面積比の分母を、切り出しても変えないために持つ。 */
  framePixels: number;
}

/** カメラと表示サイズの同一性を 1 本の文字列で比べる。 */
function cameraKey(map: MapLibreMap): string {
  const center = map.getCenter();
  const canvas = map.getCanvas();
  return [center.lng, center.lat, map.getZoom(), canvas.width, canvas.height].join('/');
}

/**
 * 地図の描画結果を読み出す。
 * MapLibre は既定で描画バッファを破棄するので、map.ts で preserveDrawingBuffer を有効にしてある。
 * WebGL の canvas からは 2D コンテキストを取れないため、いったん別の canvas に写す。
 */
function captureMap(map: MapLibreMap): Capture {
  const source = map.getCanvas();
  const scale = source.width / source.clientWidth;
  const { width, height } = source;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (context === null) throw new DetectionError('canvas を用意できませんでした');

  context.drawImage(source, 0, 0);
  // MapLibre のズームは 512px タイル基準なので、CSS ピクセルの分解能は 2^(zoom+1) で割る。
  const metersPerCssPixel =
    (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 1);
  return {
    imageData: context.getImageData(0, 0, width, height),
    scale,
    metersPerPixel: metersPerCssPixel / scale,
    camera: cameraKey(map),
    origin: { x: 0, y: 0 },
    framePixels: width * height,
  };
}

function clampInt(value: number, max: number): number {
  return Math.min(Math.max(Math.round(value), 0), max);
}

/**
 * 撮った 1 枚から、位置を変えて何度も切り出すための控え。
 *
 * カーソルを動かすたびに撮り直すと、そのたびに描いたものを隠して 1 フレーム待つことになる。
 * 写真はカメラが変わらないかぎり同じなので、1 回撮って切り出しだけを変える。
 */
export class MapSnapshot {
  readonly camera: string;
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #scale: number;
  readonly #metersPerPixel: number;

  private constructor(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    scale: number,
    metersPerPixel: number,
    camera: string
  ) {
    this.#canvas = canvas;
    this.#context = context;
    this.#scale = scale;
    this.#metersPerPixel = metersPerPixel;
    this.camera = camera;
  }

  static take(map: MapLibreMap): MapSnapshot {
    const source = map.getCanvas();
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new DetectionError('canvas を用意できませんでした');
    context.drawImage(source, 0, 0);

    const scale = source.width / source.clientWidth;
    const metersPerCssPixel =
      (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 1);
    return new MapSnapshot(canvas, context, scale, metersPerCssPixel / scale, cameraKey(map));
  }

  /** カーソルのまわりだけを切り出す。 */
  region(center: Point, sizePixels: number): Capture {
    const size = Math.round(sizePixels * this.#scale);
    const left = clampInt(Math.round(center.x * this.#scale) - size / 2, this.#canvas.width - 1);
    const top = clampInt(Math.round(center.y * this.#scale) - size / 2, this.#canvas.height - 1);
    const width = Math.min(size, this.#canvas.width - left);
    const height = Math.min(size, this.#canvas.height - top);

    return {
      imageData: this.#context.getImageData(left, top, width, height),
      scale: this.#scale,
      metersPerPixel: this.#metersPerPixel,
      camera: this.camera,
      origin: { x: left, y: top },
      framePixels: this.#canvas.width * this.#canvas.height,
    };
  }
}

export { cameraKey };

/** タイルの読み込みが終わるのを待つ。待ちきれなくても撮影には進む。 */
export async function waitForIdle(map: MapLibreMap): Promise<void> {
  if (map.loaded()) return;
  await Promise.race([
    map.once('idle'),
    new Promise((resolve) => setTimeout(resolve, IDLE_TIMEOUT_MS)),
  ]);
}

/** 地上距離をピクセル数に直す。OpenCV のカーネルは奇数でなければならない。 */
function toOddPixels(meters: number, metersPerPixel: number): number {
  const pixels = Math.round(meters / metersPerPixel) | 1;
  return Math.min(Math.max(pixels, 3), MAX_KERNEL_PIXELS);
}

/** 周長に対する epsilon を上げながら、頂点数が収まるまで間引く。 */
function simplifyContour(cv: OpenCV, contour: Mat): [number, number][] {
  const perimeter = cv.arcLength(contour, true);
  const approx = new cv.Mat();
  try {
    for (const ratio of EPSILON_RATIOS) {
      cv.approxPolyDP(contour, approx, perimeter * ratio, true);
      if (approx.rows <= MAX_VERTICES) break;
    }
    const points: [number, number][] = [];
    for (let row = 0; row < approx.rows; row += 1) {
      points.push([approx.intAt(row, 0), approx.intAt(row, 1)]);
    }
    return points;
  } finally {
    approx.delete();
  }
}

/**
 * シードを含む輪郭を返す。呼び出し側が delete する。
 *
 * 最大の輪郭で代用したりはしない。シードから離れた輪郭を黙って返すと、
 * ユーザが指していない田んぼの面積を、それと分からないまま表示することになる。
 * `contours.get()` は毎回ヒープに新しい Mat を作るので、使わないものはその場で捨てる。
 */
function takeSeedContour(
  cv: OpenCV,
  contours: InstanceType<OpenCV['MatVector']>,
  seed: InstanceType<OpenCV['Point']>
): Mat | null {
  let found: Mat | null = null;

  for (let index = 0; index < contours.size(); index += 1) {
    const contour = contours.get(index);
    if (found === null && cv.pointPolygonTest(contour, seed, false) >= 0) found = contour;
    else contour.delete();
  }
  return found;
}

/**
 * シードの 1 点から田んぼの輪郭を推定する。
 * 表示中の航空写真をフラッドフィルし、輪郭を取り出して緯度経度に戻す。
 *
 * `capture` は呼び出し側が撮る。OpenCV.js の読み込み（初回 13MB）を待つあいだに
 * 地図を動かされると、シードの画面座標と写真がずれるため。
 */
export interface DetectOptions {
  /**
   * 切り出しの縁に触れた輪郭を捨てる。
   * 縁で切られた塗りの輪郭は、畦ではなく切り取り線をなぞったものになる。
   */
  rejectEdgeContact?: boolean;
}

export async function detectOutline(
  map: MapLibreMap,
  capture: Capture,
  seed: Point,
  options: DetectOptions = {}
): Promise<Vertex[]> {
  const cv = await loadOpenCV();
  const { imageData, scale } = capture;

  // 端のクリックで画像の外を指すと、OpenCV が数値の例外を投げるだけになる。
  const clamp = (value: number, max: number): number =>
    Math.min(Math.max(Math.round(value), 0), max - 1);
  const seedPixel = new cv.Point(
    clamp(seed.x * scale - capture.origin.x, imageData.width),
    clamp(seed.y * scale - capture.origin.y, imageData.height)
  );

  // 確保は try の中で行う。途中で失敗しても、すでに取れた分は finally で解放される。
  let source: Mat | null = null;
  let rgb: Mat | null = null;
  let filled: Mat | null = null;
  let mask: Mat | null = null;
  let kernel: Mat | null = null;
  let hierarchy: Mat | null = null;
  let contours: InstanceType<OpenCV['MatVector']> | null = null;
  let contour: Mat | null = null;

  try {
    source = cv.matFromImageData(imageData);
    rgb = new cv.Mat();
    filled = new cv.Mat();
    // マスクは上下左右に 1px の番兵を持つ必要があるので、画像より 2 だけ大きく取る。
    mask = cv.Mat.zeros(imageData.height + 2, imageData.width + 2, cv.CV_8UC1);
    const kernelPixels = toOddPixels(MORPH_METERS, capture.metersPerPixel);
    kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelPixels, kernelPixels));
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();

    cv.cvtColor(source, rgb, cv.COLOR_RGBA2RGB);

    // 解像度が上がるほど圃場内部の模様（稲の条間、刈り跡）が写る。そのままだと
    // フラッドフィルが 1 枚の田んぼを渡りきれないので、地上 1m 相当でならしてから塗る。
    cv.medianBlur(rgb, rgb, toOddPixels(BLUR_METERS, capture.metersPerPixel));

    // FLOODFILL_MASK_ONLY で元画像には触れず、マスクにだけ 255 を書く。
    // FIXED_RANGE は隣接画素ではなくシードの色と比べるので、田んぼ全体の色ムラに強い。
    const tolerance = new cv.Scalar(COLOR_TOLERANCE, COLOR_TOLERANCE, COLOR_TOLERANCE, 0);
    const flags = CONNECTIVITY | cv.FLOODFILL_MASK_ONLY | cv.FLOODFILL_FIXED_RANGE | (255 << 8);
    cv.floodFill(
      rgb,
      mask,
      seedPixel,
      new cv.Scalar(0, 0, 0),
      new cv.Rect(),
      tolerance,
      tolerance,
      flags
    );

    const inner = mask.roi(new cv.Rect(1, 1, rgb.cols, rgb.rows));
    try {
      // 先に開いて、畦道の切れ目から隣の田んぼへ漏れた細い首を切り離す。
      // 閉じるのはその後。順番を逆にすると、首が太って切れなくなる。
      cv.morphologyEx(inner, filled, cv.MORPH_OPEN, kernel);
      cv.morphologyEx(filled, filled, cv.MORPH_CLOSE, kernel);
    } finally {
      inner.delete();
    }

    cv.findContours(filled, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    contour = takeSeedContour(cv, contours, seedPixel);
    if (contour === null) throw new DetectionError(NOT_FOUND);

    if (options.rejectEdgeContact === true && touchesEdge(contour, rgb.cols, rgb.rows)) {
      throw new DetectionError(NOT_FOUND);
    }

    // 分母は切り出しではなく画面全体。切り出しの面積で割ると、同じ閾値が別の意味になる。
    const ratio = cv.contourArea(contour) / capture.framePixels;
    if (ratio > MAX_AREA_RATIO) {
      throw new DetectionError('畦道を越えて広がりました。拡大するか、手動で描いてください');
    }
    if (ratio < MIN_AREA_RATIO) {
      throw new DetectionError('検出できた範囲が小さすぎます。田んぼの中央をクリックしてください');
    }

    const points = simplifyContour(cv, contour);
    if (points.length < 3) throw new DetectionError(NOT_FOUND);

    // unproject は「いまの」カメラで換算するので、撮影時とずれていたら結果を信じられない。
    if (cameraKey(map) !== capture.camera) {
      throw new DetectionError('地図が動きました。もう一度クリックしてください');
    }

    return points.map(([x, y]) => {
      const { lng, lat } = map.unproject([
        (x + capture.origin.x) / scale,
        (y + capture.origin.y) / scale,
      ]);
      return [lng, lat] satisfies Vertex;
    });
  } catch (error) {
    throw toReadableError(cv, error);
  } finally {
    for (const mat of [source, rgb, mask, filled, kernel, hierarchy, contour]) mat?.delete();
    contours?.delete();
  }
}

/**
 * 輪郭が切り出しの外周に触れているか。触れていれば、その先は読めていない。
 *
 * 見るのはシードの輪郭だけ。塗り全体で見ると、モルフォロジーで切り離した隣の田んぼの
 * かけらが縁に残っているだけで捨ててしまう——それを切り離すための処理なのに。
 */
function touchesEdge(contour: Mat, cols: number, rows: number): boolean {
  const points = contour.data32S;
  for (let index = 0; index < points.length; index += 2) {
    const x = points[index]!;
    const y = points[index + 1]!;
    if (x <= 0 || y <= 0 || x >= cols - 1 || y >= rows - 1) return true;
  }
  return false;
}

export { captureMap };
export type { Capture };
