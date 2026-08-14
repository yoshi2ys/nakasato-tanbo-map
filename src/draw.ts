import { area } from '@turf/area';
import type { FeatureCollection } from 'geojson';
import { GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl';

/** 開始点にスナップして閉合する距離（スクリーン座標 px）。 */
const SNAP_PIXELS = 12;

const SOURCE_ID = 'tanbo-draw';
const FILL_LAYER_ID = 'tanbo-draw-fill';
const LINE_LAYER_ID = 'tanbo-draw-line';
const VERTEX_LAYER_ID = 'tanbo-draw-vertex';

type Vertex = [lng: number, lat: number];

export interface DrawState {
  vertexCount: number;
  closed: boolean;
  /** 3 頂点以上のときの面積（㎡）。閉合前は暫定値。 */
  areaSquareMeters: number | null;
}

const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** 頂点リストを閉じたリング（先頭 = 末尾）にする。turf は自動で閉じない。 */
function toRing(vertices: Vertex[]): Vertex[] {
  return [...vertices, vertices[0]!];
}

/**
 * クリックで頂点を足していく手動ポリゴン描画。
 * 開始点への近接クリック、ダブルクリック、Enter のいずれでも閉合する。
 */
export class PolygonDrawer {
  readonly #map: MapLibreMap;
  readonly #source: GeoJSONSource;
  readonly #onChange: (state: DrawState) => void;
  #vertices: Vertex[] = [];
  #closed = false;
  /** ラバーバンド表示用のカーソル位置。 */
  #cursor: Vertex | null = null;
  /** 頂点が変わったときだけ計算する面積。カーソル移動では変わらない。 */
  #areaSquareMeters: number | null = null;
  /** 予約済みの再描画フレーム。mousemove ごとの再構築を 1 フレームにまとめる。 */
  #pendingFrame: number | null = null;

  constructor(map: MapLibreMap, onChange: (state: DrawState) => void) {
    this.#map = map;
    this.#onChange = onChange;
    this.#source = this.#addLayers();

    map.on('click', this.#handleClick);
    map.on('mousemove', this.#handleMouseMove);
    map.on('mouseout', this.#handleMouseOut);
    window.addEventListener('keydown', this.#handleKeyDown);

    // 閉合のダブルクリックでズームさせない。
    map.doubleClickZoom.disable();
    this.#render();
  }

  /** 描きかけを捨てて、新しいポリゴンの入力を始める。 */
  reset(): void {
    this.#vertices = [];
    this.#closed = false;
    this.#cursor = null;
    this.#areaSquareMeters = null;
    this.#render();
  }

  /** 3 頂点以上あればポリゴンを閉じる。 */
  #close(): void {
    if (this.#closed || !this.#canClose()) return;
    this.#closed = true;
    this.#cursor = null;
    this.#setCursor('');
    this.#render();
  }

  #canClose(): boolean {
    return this.#vertices.length >= 3;
  }

  #handleClick = (event: MapMouseEvent): void => {
    if (this.#closed) return;

    // ダブルクリックの 2 回目は頂点追加ではなく閉合の合図。
    if (event.originalEvent.detail >= 2) {
      this.#close();
      return;
    }

    // 開始点の上をクリックしたら、閉合できるときだけ閉じる。
    // 3 頂点未満なら同じ座標の重複頂点になるだけなので、何もしない。
    if (this.#isNearFirstVertex(event)) {
      this.#close();
      return;
    }

    this.#vertices.push(event.lngLat.toArray());
    this.#areaSquareMeters = this.#canClose()
      ? area({ type: 'Polygon', coordinates: [toRing(this.#vertices)] })
      : null;
    this.#render();
  };

  #handleMouseMove = (event: MapMouseEvent): void => {
    if (this.#closed) return;

    this.#setCursor(
      this.#canClose() && this.#isNearFirstVertex(event) ? 'pointer' : 'crosshair'
    );

    if (this.#vertices.length === 0) return;
    this.#cursor = event.lngLat.toArray();
    this.#requestRender();
  };

  #handleMouseOut = (): void => {
    if (this.#cursor === null) return;
    this.#cursor = null;
    this.#requestRender();
  };

  #handleKeyDown = (event: KeyboardEvent): void => {
    // ボタンにフォーカスがあると Enter がクリックにも化けるので、その場合は譲る。
    if (event.target instanceof HTMLButtonElement) return;

    if (event.key === 'Enter') this.#close();
    if (event.key === 'Escape' && !this.#closed) this.reset();
  };

  /** 開始点の近くかどうか。閉合できるかは #canClose() が別に決める。 */
  #isNearFirstVertex(event: MapMouseEvent): boolean {
    const first = this.#vertices[0];
    if (first === undefined) return false;
    return event.point.dist(this.#map.project(first)) <= SNAP_PIXELS;
  }

  #setCursor(cursor: string): void {
    const canvas = this.#map.getCanvas();
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }

  /** mousemove は毎フレームより速く飛んでくるので、再描画は 1 フレームに 1 回へ間引く。 */
  #requestRender(): void {
    if (this.#pendingFrame !== null) return;
    this.#pendingFrame = requestAnimationFrame(() => {
      this.#pendingFrame = null;
      this.#render();
    });
  }

  #render(): void {
    this.#source.setData(this.#buildCollection());
    this.#onChange({
      vertexCount: this.#vertices.length,
      closed: this.#closed,
      areaSquareMeters: this.#areaSquareMeters,
    });
  }

  #buildCollection(): FeatureCollection {
    const vertices = this.#vertices;
    const features: FeatureCollection['features'] = vertices.map((position, index) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: position },
      properties: { first: index === 0 },
    }));

    if (this.#closed) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [toRing(vertices)] },
        properties: {},
      });
    } else {
      // 未閉合のあいだは、最後の頂点からカーソルまでを繋いだ折れ線を見せる。
      const line = this.#cursor === null ? vertices : [...vertices, this.#cursor];
      if (line.length >= 2) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: line },
          properties: {},
        });
      }
    }

    return { type: 'FeatureCollection', features };
  }

  #addLayers(): GeoJSONSource {
    this.#map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY_COLLECTION });

    this.#map.addLayer({
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#00b0ff', 'fill-opacity': 0.25 },
    });

    this.#map.addLayer({
      id: LINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#00b0ff', 'line-width': 2 },
    });

    this.#map.addLayer({
      id: VERTEX_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['case', ['get', 'first'], 6, 4],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#00b0ff',
        'circle-stroke-width': 2,
      },
    });

    return this.#map.getSource(SOURCE_ID) as GeoJSONSource;
  }
}
