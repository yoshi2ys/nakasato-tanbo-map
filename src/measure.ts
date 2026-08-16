import { distance } from '@turf/distance';
import type { FeatureCollection } from 'geojson';
import { GeoJSONSource, Marker, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl';
import { midpoint, type Vertex } from './draw';
import { formatDistance } from './units';

const SOURCE_ID = 'tanbo-measure';
const LINE_CASING_LAYER_ID = 'tanbo-measure-casing';
const LINE_LAYER_ID = 'tanbo-measure-line';
const POINT_LAYER_ID = 'tanbo-measure-point';

/** ラベルが重ならない最短の辺の長さ（スクリーン座標 px）。 */
const MIN_LABEL_EDGE_PIXELS = 36;

export interface MeasureState {
  pointCount: number;
  /** 引いた線の合計（m）。1 点以下なら null。 */
  totalMeters: number | null;
  /** 終点をクリックし終えたか。false なら次のクリックで続きを引く。 */
  finished: boolean;
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function metersBetween(from: Vertex, to: Vertex): number {
  return distance(from, to, { units: 'meters' });
}

/**
 * 地図上で距離を測る。クリックで点を継ぎ足していき、各辺の長さを中点に、合計をパネルに出す。
 *
 * 田んぼのポリゴンとは別物として扱う。畦の長さや隣接圃場までの間隔を「その場で測る」ための
 * 道具で、保存はしない。
 */
export class MeasureTool {
  readonly #map: MapLibreMap;
  readonly #source: GeoJSONSource;
  readonly #onChange: (state: MeasureState) => void;
  #points: Vertex[] = [];
  #cursor: Vertex | null = null;
  #finished = false;
  #enabled = false;
  /** 辺ごとの長さを出す吹き出し。辺の番号で持つので、描画ごとに担当が入れ替わらない。 */
  #labels = new Map<number, Marker>();
  #pendingFrame: number | null = null;

  constructor(map: MapLibreMap, onChange: (state: MeasureState) => void) {
    this.#map = map;
    this.#onChange = onChange;
    this.#source = this.#addLayers();
    // 閉合や打ち止めのダブルクリックでズームさせない。PolygonDrawer も同じことをするが、
    // 片方だけで成り立たせると、もう片方を消したときに黙って壊れる。
    map.doubleClickZoom.disable();
  }

  /** メジャーモードのあいだだけ入力を受け取る。 */
  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;

    if (enabled) {
      this.#map.on('click', this.#handleClick);
      this.#map.on('mousemove', this.#handleMouseMove);
      this.#map.on('mouseout', this.#handleMouseOut);
      window.addEventListener('keydown', this.#handleKeyDown);
      this.#map.on('zoomend', this.#handleZoomEnd);
      return;
    }

    this.#map.off('click', this.#handleClick);
    this.#map.off('mousemove', this.#handleMouseMove);
    this.#map.off('mouseout', this.#handleMouseOut);
    window.removeEventListener('keydown', this.#handleKeyDown);
    this.#map.off('zoomend', this.#handleZoomEnd);
    // 引いた線は メジャー を出たら消す。残しておくと、自動検出が写真として読み込んで
    // フラッドフィルの壁になるうえ、他のモードには消す手立てがない。
    this.clear();
  }

  clear(): void {
    this.#points = [];
    this.#cursor = null;
    this.#finished = false;
    this.#render();
  }

  #handleClick = (event: MapMouseEvent): void => {
    // ダブルクリックの 2 回目以降は点の追加ではなく打ち止めの合図。
    // 打ち止めの判定を先に置く。あとに回すと 3 回目のクリックで測り終えた線が消える。
    if (event.originalEvent.detail >= 2) {
      this.#finish();
      return;
    }

    // 測り終えたあとの 1 クリック目は、新しい計測の始まり。
    if (this.#finished) this.clear();

    this.#points.push(event.lngLat.toArray());
    this.#render();
  };

  #handleMouseMove = (event: MapMouseEvent): void => {
    if (this.#finished || this.#points.length === 0) return;
    this.#cursor = event.lngLat.toArray();
    this.#requestRender();
  };

  #handleMouseOut = (): void => {
    if (this.#cursor === null) return;
    this.#cursor = null;
    this.#requestRender();
  };

  #handleKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLButtonElement) return;
    if (event.key === 'Enter') this.#finish();
    if (event.key === 'Escape') this.clear();
  };

  #handleZoomEnd = (): void => {
    if (this.#points.length >= 2) this.#requestRender();
  };

  #finish(): void {
    if (this.#finished || this.#points.length < 2) return;
    this.#finished = true;
    this.#cursor = null;
    this.#render();
  }

  /** カーソルまでの仮の線を含めた、いま引かれている折れ線。 */
  #line(): Vertex[] {
    if (this.#finished || this.#cursor === null) return this.#points;
    return [...this.#points, this.#cursor];
  }

  #totalMeters(line: Vertex[]): number | null {
    if (line.length < 2) return null;
    let total = 0;
    for (let index = 1; index < line.length; index += 1) {
      total += metersBetween(line[index - 1]!, line[index]!);
    }
    return total;
  }

  #requestRender(): void {
    if (this.#pendingFrame !== null) return;
    this.#pendingFrame = requestAnimationFrame(() => {
      this.#pendingFrame = null;
      this.#render();
    });
  }

  #render(): void {
    const line = this.#line();
    this.#source.setData(this.#buildCollection(line));
    this.#renderLabels(line);
    this.#onChange({
      pointCount: this.#points.length,
      totalMeters: this.#totalMeters(line),
      finished: this.#finished,
    });
  }

  #buildCollection(line: Vertex[]): FeatureCollection {
    const features: FeatureCollection['features'] = this.#points.map((position) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: position },
      properties: {},
    }));

    if (line.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: line },
        properties: {},
      });
    }
    return { type: 'FeatureCollection', features };
  }

  /**
   * 辺の中点に長さを出す。
   * MapLibre の symbol レイヤーは字を出すのに glyphs の配信元が要るので、HTML の
   * マーカーで描く。フォントを外部から取りに行かずに済む。
   */
  #renderLabels(line: Vertex[]): void {
    const wanted = new Map<number, { position: Vertex; text: string }>();
    for (let index = 1; index < line.length; index += 1) {
      const from = line[index - 1]!;
      const to = line[index]!;
      // 画面上で短すぎる辺はラベルが重なって読めないので出さない。
      if (this.#map.project(from).dist(this.#map.project(to)) < MIN_LABEL_EDGE_PIXELS) continue;
      wanted.set(index, {
        position: midpoint(from, to),
        text: formatDistance(metersBetween(from, to)),
      });
    }

    // カーソルを動かしているあいだは毎フレームここを通る。作り直すと、そのたびに
    // DOM の入れ替えと map へのリスナ登録が走るので、同じ辺のものは使い回す。
    for (const [index, marker] of this.#labels) {
      if (wanted.has(index)) continue;
      marker.remove();
      this.#labels.delete(index);
    }
    for (const [index, { position, text }] of wanted) {
      let marker = this.#labels.get(index);
      if (marker === undefined) {
        const element = document.createElement('div');
        element.className = 'measure-label';
        marker = new Marker({ element }).setLngLat(position).addTo(this.#map);
        this.#labels.set(index, marker);
      }
      marker.setLngLat(position);
      const element = marker.getElement();
      if (element.textContent !== text) element.textContent = text;
    }
  }

  #addLayers(): GeoJSONSource {
    this.#map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY });

    // 航空写真は明るいところも暗いところもあるので、白い線に黒い縁取りを付けて読ませる。
    this.#map.addLayer({
      id: LINE_CASING_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1d1d1f', 'line-width': 6, 'line-opacity': 0.55 },
    });
    this.#map.addLayer({
      id: LINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [3, 2] },
    });
    this.#map.addLayer({
      id: POINT_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 4,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#1d1d1f',
        'circle-stroke-width': 2,
      },
    });

    return this.#map.getSource(SOURCE_ID) as GeoJSONSource;
  }
}
