import type { FeatureCollection } from 'geojson';
import { GeoJSONSource, type Map as MapLibreMap, type Point } from 'maplibre-gl';
import { cameraKey, detectOutline, MapSnapshot, waitForIdle, type Capture } from './detect';
import { toRing, type Vertex } from './geometry';

const SOURCE_ID = 'tanbo-preview';
export const PREVIEW_FILL_LAYER_ID = 'tanbo-preview-fill';
export const PREVIEW_LINE_LAYER_ID = 'tanbo-preview-line';

/** カーソルが止まったとみなすまでの時間。短いほど追従するが、そのぶん走る回数が増える。 */
const STILL_MS = 200;
/** 読み取る正方形の一辺（CSS ピクセル）。画面全体の 1/4 以下に収める。 */
const REGION_PIXELS = 512;
/** 縁に触れて捨てられたとき、一度だけ広げて試す倍率。 */
const RETRY_SCALE = 1.5;
/** クリック位置がプレビューの位置からこれだけ離れていたら、見えているものと違うとみなす。 */
export const COMMIT_SLACK_PIXELS = 8;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * 自動検出の下見。カーソルが止まったところで 1 回だけ検出し、輪郭を薄く出す。
 *
 * ここでは item を作らないし、保存もしない。失敗しても何も言わない（カーソルを動かす
 * たびにエラーが点滅するほうが困る）。クリックされたら、そのとき出ている輪郭をそのまま返す。
 */
export class DetectPreview {
  readonly #map: MapLibreMap;
  readonly #source: GeoJSONSource;
  #enabled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  /** 走っているあいだに動いたカーソル。終わってから改めて 1 回だけ追いかける。 */
  #pending: Point | null = null;
  /** 撮影の使い回し。カメラが変わらないかぎり、写真は同じ。 */
  #snapshot: MapSnapshot | null = null;
  #vertices: Vertex[] | null = null;
  #at: Point | null = null;

  /** 描いたものを写さないために、撮る直前だけ隠してもらう。 */
  readonly #mask: (masked: boolean) => void;

  constructor(map: MapLibreMap, mask: (masked: boolean) => void, beforeId?: string) {
    this.#map = map;
    this.#mask = mask;
    this.#source = this.#addLayers(beforeId);
    map.on('move', this.#handleMove);
  }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    if (!enabled) this.clear();
  }

  /** カーソルが動いた。止まるまで待ってから 1 回だけ走らせる。 */
  moved(point: Point): void {
    if (!this.#enabled) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#run(point), STILL_MS);
  }

  /**
   * クリックで確定する。いま出ている輪郭をそのまま返す。
   * 見えているものと違うものを確定させないため、離れた場所では何も返さない。
   */
  commit(point: Point): Vertex[] | null {
    if (this.#vertices === null || this.#at === null) return null;
    if (point.dist(this.#at) > COMMIT_SLACK_PIXELS) return null;
    const vertices = this.#vertices;
    this.clear();
    return vertices;
  }

  clear(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = null;
    this.#vertices = null;
    this.#at = null;
    this.#source.setData(EMPTY);
  }

  destroy(): void {
    this.clear();
    this.#map.off('move', this.#handleMove);
    for (const id of [PREVIEW_FILL_LAYER_ID, PREVIEW_LINE_LAYER_ID]) {
      if (this.#map.getLayer(id) !== undefined) this.#map.removeLayer(id);
    }
    if (this.#map.getSource(SOURCE_ID) !== undefined) this.#map.removeSource(SOURCE_ID);
  }

  /** 撮影を捨てる合図。地図が動けば写真も変わる。 */
  #handleMove = (): void => {
    this.#snapshot = null;
    if (this.#vertices !== null) this.clear();
  };

  async #run(point: Point): Promise<void> {
    if (!this.#enabled) return;
    // 走っているあいだは積まない。積むと、もう見ていない場所の結果が遅れて出る。
    if (this.#running) {
      this.#pending = point;
      return;
    }

    this.#running = true;
    try {
      const snapshot = await this.#snapshotFor();
      const vertices = await this.#detect(snapshot, point);
      if (!this.#enabled) return;
      this.#vertices = vertices;
      this.#at = point;
      this.#source.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [toRing(vertices)] },
            properties: {},
          },
        ],
      });
    } catch {
      // 下見なので、取れなければ何も出さない。理由は出さない。
      this.#vertices = null;
      this.#at = null;
      this.#source.setData(EMPTY);
    } finally {
      this.#running = false;
      const next = this.#pending;
      this.#pending = null;
      if (next !== null) void this.#run(next);
    }
  }

  /** 縁で切られた輪郭は捨てて、一度だけ広げて試す。 */
  async #detect(snapshot: MapSnapshot, point: Point): Promise<Vertex[]> {
    const attempt = (sizePixels: number): Promise<Vertex[]> =>
      detectOutline(this.#map, snapshot.region(point, sizePixels) satisfies Capture, point, {
        rejectEdgeContact: true,
      });
    try {
      return await attempt(REGION_PIXELS);
    } catch {
      return attempt(REGION_PIXELS * RETRY_SCALE);
    }
  }

  /**
   * 撮影は、カメラが同じあいだ使い回す。
   * プレビュー用の写真には描いたものが写らないので、item が増えても色が変わっても撮り直さない。
   */
  async #snapshotFor(): Promise<MapSnapshot> {
    const current = this.#snapshot;
    if (current !== null && current.camera === cameraKey(this.#map)) return current;

    // タイルを待つのは隠す前。隠したまま何秒も待つと、そのあいだ描いたものが消えて見える。
    await waitForIdle(this.#map);

    this.#mask(true);
    try {
      // 隠した状態が画に出るまで 1 フレーム待つ。待たないと隠す前の絵を撮ってしまう。
      await new Promise((resolve) => {
        this.#map.once('render', () => resolve(undefined));
        this.#map.triggerRepaint();
      });
      this.#snapshot = MapSnapshot.take(this.#map);
      return this.#snapshot;
    } finally {
      this.#mask(false);
    }
  }

  #addLayers(beforeId?: string): GeoJSONSource {
    this.#map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY });
    this.#map.addLayer(
      {
        id: PREVIEW_FILL_LAYER_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: { 'fill-color': '#ffb300', 'fill-opacity': 0.12 },
      },
      beforeId
    );
    this.#map.addLayer(
      {
        id: PREVIEW_LINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // 破線にして「まだ確定していない」ことを見て分かるようにする。
        paint: { 'line-color': '#ffb300', 'line-width': 2, 'line-dasharray': [2, 2] },
      },
      beforeId
    );
    return this.#map.getSource(SOURCE_ID) as GeoJSONSource;
  }
}
