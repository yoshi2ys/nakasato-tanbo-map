import { area } from '@turf/area';
import type { FeatureCollection } from 'geojson';
import { GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent, type Point } from 'maplibre-gl';

/** 開始点にスナップして閉合する距離（スクリーン座標 px）。 */
const SNAP_PIXELS = 12;
/** 頂点・ゴーストを掴める距離（スクリーン座標 px）。 */
const HIT_PIXELS = 9;
/** 中点ゴーストを出す辺の最小の長さ（スクリーン座標 px）。 */
const MIN_GHOST_EDGE_PIXELS = 32;
/** ポリゴンとして成立する最小の頂点数。 */
const MIN_VERTICES = 3;

const SOURCE_ID = 'tanbo-draw';
/** 保存済みの田んぼは、この層より下に敷く。 */
export const FILL_LAYER_ID = 'tanbo-draw-fill';
const LINE_LAYER_ID = 'tanbo-draw-line';
const VERTEX_LAYER_ID = 'tanbo-draw-vertex';

export type Vertex = [lng: number, lat: number];

/** `drawing` は頂点を足していく段階、`editing` は閉合後の調整段階。 */
export type DrawMode = 'drawing' | 'editing';

/** 頂点そのものか、辺の中点に置く「押すと頂点になる」ゴーストか。 */
type PointRole = 'start' | 'vertex' | 'ghost';

interface Hit {
  role: 'vertex' | 'ghost';
  /** vertex なら頂点の番号、ghost なら辺の番号。 */
  index: number;
}

export interface DrawState {
  mode: DrawMode;
  vertexCount: number;
  /** 3 頂点以上のときの面積（㎡）。閉合前は暫定値。 */
  areaSquareMeters: number | null;
  canDeleteVertex: boolean;
  /** 輪郭が自分自身と交差している状態。この面積は当てにならない。 */
  selfIntersecting: boolean;
}

const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** 頂点リストを閉じたリング（先頭 = 末尾）にする。turf は自動で閉じない。 */
function toRing(vertices: Vertex[]): Vertex[] {
  return [...vertices, vertices[0]!];
}

/** 田んぼ 1 枚のスケールでは、中点は緯度経度の単純平均で十分。 */
export function midpoint(a: Vertex, b: Vertex): Vertex {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function cross(origin: Vertex, a: Vertex, b: Vertex): number {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

/** 線分どうしが交わるか。端点で接するだけの場合は交差とみなさない。 */
function segmentsCross(a1: Vertex, a2: Vertex, b1: Vertex, b2: Vertex): boolean {
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/**
 * 輪郭が自分自身と交差しているか。
 * turf の面積計算は交差したリングでも黙って値を返すので、こちらで見張る。
 */
export function isSelfIntersecting(vertices: Vertex[]): boolean {
  const count = vertices.length;
  if (count < 4) return false;

  for (let i = 0; i < count; i += 1) {
    for (let j = i + 2; j < count; j += 1) {
      // 端点を共有する隣り合う辺は、交差の判定から外す。
      if (i === 0 && j === count - 1) continue;
      const crossed = segmentsCross(
        vertices[i]!,
        vertices[(i + 1) % count]!,
        vertices[j]!,
        vertices[(j + 1) % count]!
      );
      if (crossed) return true;
    }
  }
  return false;
}

/**
 * 手動ポリゴンの描画と、閉合後の頂点編集。
 * 描画中はクリックで頂点を足し、開始点への近接クリック・ダブルクリック・Enter で閉じる。
 * 閉合後は頂点のドラッグ移動、辺の中点からの頂点追加、右クリック / Delete での削除ができる。
 */
export class PolygonDrawer {
  readonly #map: MapLibreMap;
  readonly #source: GeoJSONSource;
  readonly #onChange: (state: DrawState) => void;
  #mode: DrawMode = 'drawing';
  #vertices: Vertex[] = [];
  /** 描画中のラバーバンド表示用のカーソル位置。 */
  #cursor: Vertex | null = null;
  /** 編集中に選択している頂点。Delete の対象になる。 */
  #selected: number | null = null;
  /** ドラッグ中の頂点。 */
  #dragging: number | null = null;
  /** 頂点が変わったときだけ計算する面積。カーソル移動では変わらない。 */
  #areaSquareMeters: number | null = null;
  #selfIntersecting = false;
  #enabled = true;
  /** 予約済みの再描画フレーム。mousemove ごとの再構築を 1 フレームにまとめる。 */
  #pendingFrame: number | null = null;

  constructor(map: MapLibreMap, onChange: (state: DrawState) => void) {
    this.#map = map;
    this.#onChange = onChange;
    this.#source = this.#addLayers();

    this.#addInputListeners();
    // ゴーストを出す辺はスクリーン上の長さで決まるので、ズームが変わったら引き直す。
    map.on('zoomend', this.#handleZoomEnd);

    // 閉合のダブルクリックでズームさせない。
    map.doubleClickZoom.disable();
    this.#render();
  }

  #addInputListeners(): void {
    this.#map.on('click', this.#handleClick);
    this.#map.on('mousemove', this.#handleMouseMove);
    this.#map.on('mouseout', this.#handleMouseOut);
    this.#map.on('mousedown', this.#handleMouseDown);
    this.#map.on('contextmenu', this.#handleContextMenu);
    window.addEventListener('keydown', this.#handleKeyDown);
  }

  #removeInputListeners(): void {
    this.#map.off('click', this.#handleClick);
    this.#map.off('mousemove', this.#handleMouseMove);
    this.#map.off('mouseout', this.#handleMouseOut);
    this.#map.off('mousedown', this.#handleMouseDown);
    this.#map.off('contextmenu', this.#handleContextMenu);
    window.removeEventListener('keydown', this.#handleKeyDown);
  }

  /** 自動検出が写真だけを読めるよう、描いたものを一時的に隠す。 */
  setLayersVisible(visible: boolean): void {
    const visibility = visible ? 'visible' : 'none';
    for (const id of [FILL_LAYER_ID, LINE_LAYER_ID, VERTEX_LAYER_ID]) {
      this.#map.setLayoutProperty(id, 'visibility', visibility);
    }
  }

  /**
   * 入力を受け付けるかどうか。自動検出モードのあいだは、クリックを検出側に譲る。
   * 描いたものはそのまま残す。
   */
  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;

    if (enabled) {
      this.#addInputListeners();
      return;
    }
    this.#removeInputListeners();
    this.#endDrag();
    this.#cursor = null;
    this.#setCursor('');
    this.#render();
  }

  /** いま編集している頂点。保存するときに読む（毎フレームではないのでコピーで渡す）。 */
  get vertices(): Vertex[] {
    return this.#vertices.map((vertex) => [...vertex] satisfies Vertex);
  }

  /** 外から作った輪郭（自動検出の結果）を、そのまま編集できる状態で受け取る。 */
  load(vertices: Vertex[]): void {
    if (vertices.length < MIN_VERTICES) {
      throw new Error(`頂点が ${MIN_VERTICES} 個に足りません`);
    }
    this.#mode = 'editing';
    this.#vertices = vertices.map((vertex) => [...vertex] satisfies Vertex);
    this.#cursor = null;
    this.#selected = null;
    this.#endDrag();
    this.#commitVertices();
  }

  /** 描いたものを捨てて、新しいポリゴンの入力を始める。 */
  reset(): void {
    this.#mode = 'drawing';
    this.#vertices = [];
    this.#cursor = null;
    this.#selected = null;
    this.#endDrag();
    this.#areaSquareMeters = null;
    this.#selfIntersecting = false;
    this.#setCursor('');
    this.#render();
  }

  // MARK: - 描画

  #handleClick = (event: MapMouseEvent): void => {
    if (this.#mode === 'editing') {
      // 頂点の外をクリックしたら選択を解除する。
      const hit = this.#hitTest(event.point);
      this.#selected = hit?.role === 'vertex' ? hit.index : null;
      this.#render();
      return;
    }

    // ダブルクリックの 2 回目は頂点追加ではなく閉合の合図。
    if (event.originalEvent.detail >= 2) {
      this.#close();
      return;
    }

    // 開始点の上をクリックしたら、閉合できるときだけ閉じる。
    // 3 頂点未満なら同じ座標の重複頂点になるだけなので、何もしない。
    if (this.#isNearFirstVertex(event.point)) {
      this.#close();
      return;
    }

    this.#vertices.push(event.lngLat.toArray());
    this.#commitVertices();
  };

  /** 3 頂点以上あればポリゴンを閉じて編集に移る。 */
  #close(): void {
    if (this.#mode === 'editing' || !this.#canClose()) return;
    this.#mode = 'editing';
    this.#cursor = null;
    this.#setCursor('');
    this.#render();
  }

  #canClose(): boolean {
    return this.#vertices.length >= MIN_VERTICES;
  }

  /** 開始点の近くかどうか。閉合できるかは #canClose() が別に決める。 */
  #isNearFirstVertex(point: Point): boolean {
    const first = this.#vertices[0];
    if (first === undefined) return false;
    return point.dist(this.#map.project(first)) <= SNAP_PIXELS;
  }

  // MARK: - 編集

  #handleMouseDown = (event: MapMouseEvent): void => {
    // 主ボタン以外は掴まない。右ボタンで preventDefault すると MapLibre が続く
    // contextmenu を握り潰す。macOS の ctrl + クリックも右クリック扱いなので外す。
    const mouse = event.originalEvent;
    if (this.#mode !== 'editing' || mouse.button !== 0 || mouse.ctrlKey) return;

    const hit = this.#hitTest(event.point);
    if (hit === null) return;

    // 掴んでいるあいだ地図をパンさせない。
    event.preventDefault();

    if (hit.role === 'ghost') {
      // ゴーストは辺 i の中点。掴んだ瞬間に本物の頂点として辺の間に差し込む。
      this.#vertices.splice(hit.index + 1, 0, this.#edgeMidpoint(hit.index));
      this.#dragging = hit.index + 1;
    } else {
      this.#dragging = hit.index;
    }

    this.#selected = this.#dragging;
    this.#map.on('mousemove', this.#handleDragMove);
    // 地図の外（パネルの上やウィンドウの外）で離しても掴みっぱなしにならないよう、
    // map ではなく window で mouseup を待つ。
    window.addEventListener('mouseup', this.#handleDragEnd, { once: true });
    this.#commitVertices();
  };

  #handleDragMove = (event: MapMouseEvent): void => {
    if (this.#dragging === null) return;

    // ウィンドウの外でボタンを離された場合は mouseup が来ないので、ここで気づく。
    if (event.originalEvent.buttons === 0) {
      this.#handleDragEnd();
      return;
    }

    this.#vertices[this.#dragging] = event.lngLat.toArray();
    this.#commitVertices(true);
  };

  #handleDragEnd = (): void => {
    if (this.#dragging === null) return;
    this.#endDrag();
    this.#render();
  };

  #endDrag(): void {
    this.#map.off('mousemove', this.#handleDragMove);
    window.removeEventListener('mouseup', this.#handleDragEnd);
    this.#dragging = null;
  }

  #handleContextMenu = (event: MapMouseEvent): void => {
    if (this.#mode !== 'editing' || this.#dragging !== null) return;
    const hit = this.#hitTest(event.point);
    if (hit?.role !== 'vertex') return;
    event.preventDefault();
    this.#deleteVertex(hit.index);
  };

  #handleZoomEnd = (): void => {
    if (this.#mode === 'editing') this.#requestRender();
  };

  /** 頂点を削除する。MIN_VERTICES を下回る削除はしない。 */
  #deleteVertex(index: number): void {
    // ドラッグ中に消すと #dragging の指す番号がずれて、別の頂点が動き出す。
    if (this.#dragging !== null || !this.#canDeleteVertex()) return;
    this.#vertices.splice(index, 1);

    if (this.#selected === index) this.#selected = null;
    else if (this.#selected !== null && this.#selected > index) this.#selected -= 1;

    this.#commitVertices();
  }

  #canDeleteVertex(): boolean {
    return this.#vertices.length > MIN_VERTICES;
  }

  /** 辺 i の中点。辺 i は頂点 i と i+1（末尾の次は先頭）を結ぶ。 */
  #edgeMidpoint(index: number): Vertex {
    const vertices = this.#vertices;
    return midpoint(vertices[index]!, vertices[(index + 1) % vertices.length]!);
  }

  /**
   * 中点ゴーストを出す辺の番号。
   * 短い辺の中点は頂点と重なって「掴んだつもりが増えた」になるので外す。
   */
  #ghostEdges(): number[] {
    const vertices = this.#vertices;
    const edges: number[] = [];
    for (const [index, position] of vertices.entries()) {
      const from = this.#map.project(position);
      const to = this.#map.project(vertices[(index + 1) % vertices.length]!);
      if (from.dist(to) >= MIN_GHOST_EDGE_PIXELS) edges.push(index);
    }
    return edges;
  }

  /**
   * 画面座標での当たり判定。頂点を優先し、重なったときにゴーストが勝たないようにする。
   * queryRenderedFeatures は直前に描いたフレームを見るため、setData 直後は古い番号を返す。
   */
  #hitTest(point: Point): Hit | null {
    let hit: Hit | null = null;
    let best = HIT_PIXELS;

    for (const [index, position] of this.#vertices.entries()) {
      const distance = point.dist(this.#map.project(position));
      if (distance <= best) {
        hit = { role: 'vertex', index };
        best = distance;
      }
    }
    if (hit !== null) return hit;

    for (const index of this.#ghostEdges()) {
      const distance = point.dist(this.#map.project(this.#edgeMidpoint(index)));
      if (distance <= best) {
        hit = { role: 'ghost', index };
        best = distance;
      }
    }
    return hit;
  }

  // MARK: - 入力の共通処理

  #handleMouseMove = (event: MapMouseEvent): void => {
    if (this.#mode === 'editing') {
      if (this.#dragging !== null) return;
      const hit = this.#hitTest(event.point);
      this.#setCursor(hit === null ? '' : hit.role === 'ghost' ? 'copy' : 'move');
      return;
    }

    this.#setCursor(
      this.#canClose() && this.#isNearFirstVertex(event.point) ? 'pointer' : 'crosshair'
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

    if (this.#mode === 'editing') {
      if (event.key === 'Escape') {
        this.#selected = null;
        this.#render();
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && this.#selected !== null) {
        this.#deleteVertex(this.#selected);
      }
      return;
    }

    if (event.key === 'Enter') this.#close();
    if (event.key === 'Escape') this.reset();
  };

  #setCursor(cursor: string): void {
    const canvas = this.#map.getCanvas();
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }

  // MARK: - 描画の反映

  /** 頂点を変えたあとの後始末。面積と交差を計算し直して再描画する。 */
  #commitVertices(coalesce = false): void {
    this.#areaSquareMeters = this.#canClose()
      ? area({ type: 'Polygon', coordinates: [toRing(this.#vertices)] })
      : null;
    this.#selfIntersecting = isSelfIntersecting(this.#vertices);
    if (coalesce) this.#requestRender();
    else this.#render();
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
      mode: this.#mode,
      vertexCount: this.#vertices.length,
      areaSquareMeters: this.#areaSquareMeters,
      canDeleteVertex: this.#canDeleteVertex(),
      selfIntersecting: this.#selfIntersecting,
    });
  }

  #buildCollection(): FeatureCollection {
    const vertices = this.#vertices;
    const editing = this.#mode === 'editing';

    const features: FeatureCollection['features'] = vertices.map((position, index) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: position },
      properties: {
        role: (!editing && index === 0 ? 'start' : 'vertex') satisfies PointRole,
        selected: index === this.#selected,
      },
    }));

    if (editing) {
      // ドラッグ中は中点が動き続けて狙いを付けられないので、そのあいだは出さない。
      if (this.#dragging === null) {
        for (const index of this.#ghostEdges()) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: this.#edgeMidpoint(index) },
            properties: { role: 'ghost' satisfies PointRole },
          });
        }
      }

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
        // ゴーストは「まだ頂点ではない」ことが見て分かるよう、小さく薄くする。
        'circle-radius': ['match', ['get', 'role'], 'start', 6, 'ghost', 3.5, 5],
        // ゴーストには selected を持たせていないので、== で null を false に落とす。
        'circle-color': ['case', ['==', ['get', 'selected'], true], '#00b0ff', '#ffffff'],
        'circle-opacity': ['match', ['get', 'role'], 'ghost', 0.5, 1],
        'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], '#ffffff', '#00b0ff'],
        'circle-stroke-width': ['match', ['get', 'role'], 'ghost', 1.5, 2],
        'circle-stroke-opacity': ['match', ['get', 'role'], 'ghost', 0.5, 1],
      },
    });

    return this.#map.getSource(SOURCE_ID) as GeoJSONSource;
  }
}
