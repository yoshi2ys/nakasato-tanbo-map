import type { FeatureCollection } from 'geojson';
import {
  GeoJSONSource,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type MapTouchEvent,
  type Point,
} from 'maplibre-gl';
import { isTyping } from './ui/dom';
import {
  isSelfIntersecting,
  lineLength,
  midpoint,
  polygonArea,
  toRing,
  type Vertex,
} from './geometry';

/** 開始点にスナップして閉合する距離（スクリーン座標 px）。 */
const SNAP_PIXELS = 12;
/** 頂点・ゴーストを掴める距離（スクリーン座標 px）。 */
const HIT_PIXELS = 9;
/** 指で掴むときの距離。指先は矢印より太いので広く取る。 */
const TOUCH_HIT_PIXELS = 20;
/**
 * 計測の破線。dasharray の単位は線の太さなので、線と縁取りで別の値が要る。
 * どちらも 10px の線と 7.5px の空きになるように、太さ（2.5px と 6px）で割ってある。
 * 縁取りだけ実線のままだと、下に黒い線が通って破線に見えない。
 */
export const MEASURE_WIDTH = 2.5;
export const MEASURE_CASING_WIDTH = 6;
export const MEASURE_DASH: [number, number] = [4, 3];
export const MEASURE_CASING_DASH: [number, number] = [
  (4 * MEASURE_WIDTH) / MEASURE_CASING_WIDTH,
  (3 * MEASURE_WIDTH) / MEASURE_CASING_WIDTH,
];

/** 中点ゴーストを出す辺の最小の長さ（スクリーン座標 px）。 */
const MIN_GHOST_EDGE_PIXELS = 32;

const SOURCE_ID = 'tanbo-edit';
/** 保存済みのものは、この層より下に敷く。 */
export const EDIT_FILL_LAYER_ID = 'tanbo-edit-fill';
const EDIT_CASING_LAYER_ID = 'tanbo-edit-casing';
const EDIT_LINE_LAYER_ID = 'tanbo-edit-line';
const EDIT_VERTEX_LAYER_ID = 'tanbo-edit-vertex';

const EDIT_LAYER_IDS = [
  EDIT_FILL_LAYER_ID,
  EDIT_CASING_LAYER_ID,
  EDIT_LINE_LAYER_ID,
  EDIT_VERTEX_LAYER_ID,
];

/** 面・線・点。田んぼ・計測・ピンの形をそのまま呼び分ける。 */
export type EditKind = 'polygon' | 'line' | 'point';

/** `drawing` は頂点を足していく段階、`editing` は確定後の調整段階。 */
export type EditPhase = 'drawing' | 'editing';

const MIN_VERTICES: Record<EditKind, number> = { polygon: 3, line: 2, point: 1 };

/** 頂点そのものか、辺の中点に置く「押すと頂点になる」ゴーストか。 */
type PointRole = 'start' | 'vertex' | 'ghost';

interface Hit {
  role: 'vertex' | 'ghost';
  /** vertex なら頂点の番号、ghost なら辺の番号。 */
  index: number;
}

export interface EditState {
  kind: EditKind;
  phase: EditPhase;
  vertexCount: number;
  /** 選んでいる頂点の番号。削除の対象になる。 */
  selectedVertex: number | null;
  /** polygon のときの面積（㎡）。閉合前は暫定値。 */
  areaSquareMeters: number | null;
  /** line のときの全長（m）。 */
  totalMeters: number | null;
  canDeleteVertex: boolean;
  /** 輪郭が自分自身と交差している状態。この面積は当てにならない。 */
  selfIntersecting: boolean;
  /** 確定した線の末尾から、また点を置ける状態か。 */
  canResume: boolean;
}

const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * 選択中のものを描いて、直接いじらせる。
 *
 * 描画中はクリックで頂点を足し、開始点への近接クリック・ダブルクリック・Enter で確定する。
 * 確定後は頂点のドラッグ移動、辺の中点からの頂点追加、右クリック / Delete での削除ができる。
 * 面・線・点の違いは、最小の頂点数と、閉じるかどうかと、面積を出すかどうかだけ。
 */
export class ItemEditor {
  readonly #map: MapLibreMap;
  readonly #source: GeoJSONSource;
  readonly #onChange: (state: EditState) => void;
  #kind: EditKind = 'polygon';
  #phase: EditPhase = 'drawing';
  #vertices: Vertex[] = [];
  #color = '#00b0ff';
  /** 描画中のラバーバンド表示用のカーソル位置。 */
  #cursor: Vertex | null = null;
  /** 編集中に選択している頂点。Delete の対象になる。 */
  #selected: number | null = null;
  /** ドラッグ中の頂点。 */
  #dragging: number | null = null;
  /** 指で操作しているか。掴める距離が変わる。 */
  #touching = false;
  /** 頂点が変わったときだけ計算する。カーソル移動では変わらない。 */
  #areaSquareMeters: number | null = null;
  #totalMeters: number | null = null;
  #selfIntersecting = false;
  #enabled = true;
  readonly #onRestart: () => void;
  /** 継ぎ足しを始める前の形。「やめる」で戻す先になる。 */
  #resumedFrom: Vertex[] | null = null;
  /** 直後の click を捨てるか。頂点を掴んで離した手が、そのまま次の点を置かないように。 */
  #swallowNextClick = false;
  /** 掴んでから実際に動いたか。動いていなければ、その click は掴む前と同じ意味を持つ。 */
  #dragMoved = false;
  /** 予約済みの再描画フレーム。mousemove ごとの再構築を 1 フレームにまとめる。 */
  #pendingFrame: number | null = null;

  /**
   * @param onRestart 確定したものから離れて、次を描き始めたときに 1 回だけ呼ぶ。
   *   状態の遷移だけでは、モードの切り替えで作り直したのか、ユーザーが次を描き始めたのかを
   *   見分けられない（どちらも editing → drawing に見える）。
   */
  constructor(
    map: MapLibreMap,
    onChange: (state: EditState) => void,
    onRestart: () => void = () => {}
  ) {
    this.#map = map;
    this.#onChange = onChange;
    this.#onRestart = onRestart;
    this.#source = this.#addLayers();

    this.#addInputListeners();
    // ゴーストを出す辺はスクリーン上の長さで決まるので、ズームが変わったら引き直す。
    map.on('zoomend', this.#handleZoomEnd);

    // 閉合のダブルクリックでズームさせない。
    map.doubleClickZoom.disable();
    // ここで onChange まで呼ぶと、まだ組み上がっていない画面を触りに行く。
    this.#source.setData(this.#buildCollection());
  }

  #addInputListeners(): void {
    this.#map.on('click', this.#handleClick);
    this.#map.on('mousemove', this.#handleMouseMove);
    this.#map.on('mouseout', this.#handleMouseOut);
    this.#map.on('mousedown', this.#handleMouseDown);
    this.#map.on('touchstart', this.#handleTouchStart);
    this.#map.on('contextmenu', this.#handleContextMenu);
    window.addEventListener('keydown', this.#handleKeyDown);
  }

  #removeInputListeners(): void {
    this.#map.off('click', this.#handleClick);
    this.#map.off('mousemove', this.#handleMouseMove);
    this.#map.off('mouseout', this.#handleMouseOut);
    this.#map.off('mousedown', this.#handleMouseDown);
    this.#map.off('touchstart', this.#handleTouchStart);
    this.#map.off('contextmenu', this.#handleContextMenu);
    window.removeEventListener('keydown', this.#handleKeyDown);
  }

  /** 自動検出が写真だけを読めるよう、描いたものを一時的に隠す。 */
  setLayersVisible(visible: boolean): void {
    const visibility = visible ? 'visible' : 'none';
    for (const id of EDIT_LAYER_IDS) {
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

  /** 新しく描き始める。 */
  begin(kind: EditKind, color: string): void {
    this.#kind = kind;
    this.#color = color;
    this.#applyColor();
    this.#resumedFrom = null;
    this.#phase = 'drawing';
    this.#vertices = [];
    this.#cursor = null;
    this.#selected = null;
    this.#endDrag();
    this.#areaSquareMeters = null;
    this.#totalMeters = null;
    this.#selfIntersecting = false;
    this.#setCursor('');
    this.#render();
  }

  /** できあがっているもの（保存済み、または自動検出の結果）を編集に載せる。 */
  load(kind: EditKind, vertices: Vertex[], color: string): void {
    if (vertices.length < MIN_VERTICES[kind]) {
      throw new Error(`頂点が ${MIN_VERTICES[kind]} 個に足りません`);
    }
    this.#kind = kind;
    this.#color = color;
    this.#applyColor();
    this.#phase = 'editing';
    this.#vertices = vertices.map((vertex) => [...vertex] satisfies Vertex);
    this.#cursor = null;
    this.#selected = null;
    this.#endDrag();
    this.#commitVertices();
  }

  setColor(color: string): void {
    if (this.#color === color) return;
    this.#color = color;
    this.#applyColor();
  }

  // MARK: - 描画

  #handleClick = (event: MapMouseEvent): void => {
    // 頂点を掴んで離した手。ここで点を足すと、掴んだ場所に重ねて置くことになる。
    if (this.#swallowNextClick) {
      this.#swallowNextClick = false;
      return;
    }
    if (this.#phase === 'editing') {
      const hit = this.#hitTest(event.point);
      /*
       * 形から離れたところを押したのは「この 1 本は終わり、次を描く」の合図。
       * 道具を押し直させると、続けて何本も測るときに手が止まる。
       * 点（ピン）は 1 回で決まるので、ここでは増やさない。
       */
      if (hit === null && this.#kind !== 'point') {
        this.#onRestart();
        this.begin(this.#kind, this.#color);
      } else {
        // 頂点の外をクリックしたら選択を解除する。
        this.#selected = hit?.role === 'vertex' ? hit.index : null;
        this.#render();
        return;
      }
    }

    // ダブルクリックの 2 回目は頂点追加ではなく確定の合図。
    if (event.originalEvent.detail >= 2) {
      this.#close();
      return;
    }

    // 開始点の上をクリックしたら、閉合できるときだけ閉じる。
    // 頂点が足りなければ同じ座標の重複頂点になるだけなので、何もしない。
    if (this.#kind === 'polygon' && this.#isNearFirstVertex(event.point)) {
      this.#close();
      return;
    }

    this.#vertices.push(event.lngLat.toArray());
    // 点は 1 つ置いた時点で決まり。
    if (this.#kind === 'point') {
      this.#phase = 'editing';
      this.#setCursor('');
    }
    this.#commitVertices();
  };

  /**
   * 頂点が足りていれば確定する。
   * ダブルクリックや Enter が使えない環境のために、外からも呼べるようにしてある。
   */
  finish(): void {
    this.#close();
  }

  /**
   * 確定した線の末尾から、また点を置けるようにする。
   *
   * 面は閉じてしまうと継ぎ足す先がないので、線だけ。クリックの意味は
   * 「離れたところ＝次の 1 本」に使ってしまったので、継ぎ足しはボタンで受ける。
   */
  resume(): void {
    if (this.#kind !== 'line' || this.#phase !== 'editing') return;
    // 「やめる」で継ぎ足す前に戻れるよう、いまの形を控える。
    this.#resumedFrom = this.#vertices.map((vertex) => [...vertex] satisfies Vertex);
    this.#phase = 'drawing';
    this.#selected = null;
    this.#endDrag();
    this.#render();
  }

  /** いま継ぎ足せるか。ボタンを出すかどうかの判断に使う。 */
  get canResume(): boolean {
    return this.#kind === 'line' && this.#phase === 'editing' && this.#vertices.length > 0;
  }

  /**
   * 描きかけを捨てる。Esc と同じ働きで、キーボードのない端末のために外から呼べる。
   *
   * 継ぎ足している最中は、捨てるのは継ぎ足したぶんだけ。もとからあった線まで消すと、
   * 保存済みのものが地図から消えたように見える。
   */
  discard(): void {
    const before = this.#resumedFrom;
    if (before === null) {
      this.begin(this.#kind, this.#color);
      return;
    }
    this.#resumedFrom = null;
    this.#vertices = before;
    this.#phase = 'editing';
    this.#cursor = null;
    this.#selected = null;
    this.#endDrag();
    this.#setCursor('');
    this.#commitVertices();
  }

  /** 選んでいる頂点を消す。右クリックや Delete の代わりに、ボタンからも呼べる。 */
  deleteSelectedVertex(): void {
    if (this.#selected === null) return;
    this.#deleteVertex(this.#selected);
  }

  /** いま確定できるか。確定のボタンを出すかどうかの判断に使う。 */
  get canFinish(): boolean {
    return this.#phase === 'drawing' && this.#canClose();
  }

  /** 頂点が足りていれば確定して編集に移る。 */
  #close(): void {
    if (this.#phase === 'editing' || !this.#canClose()) return;
    this.#resumedFrom = null;
    this.#phase = 'editing';
    this.#cursor = null;
    this.#setCursor('');
    this.#render();
  }

  #canClose(): boolean {
    return this.#vertices.length >= MIN_VERTICES[this.#kind];
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
    if (mouse.button !== 0 || mouse.ctrlKey) return;

    const hit = this.#hitTest(event.point);
    if (hit === null || !this.#canGrab(hit)) return;

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
    this.#dragMoved = false;
    this.#map.on('mousemove', this.#handleDragMove);
    // 地図の外（パネルの上やウィンドウの外）で離しても掴みっぱなしにならないよう、
    // map ではなく window で mouseup を待つ。
    window.addEventListener('mouseup', this.#handleDragEnd, { once: true });
    this.#commitVertices();
  };

  /**
   * 指で頂点を掴む。
   *
   * maplibre はタップを click に直してくれるので頂点を置くのは同じ経路で済むが、
   * ドラッグは touch のまま来る。2 本指は地図の拡大縮小なので手を出さない。
   */
  #handleTouchStart = (event: MapTouchEvent): void => {
    if (event.points.length > 1) return;

    this.#touching = true;
    const hit = this.#hitTest(event.point);
    if (hit === null || !this.#canGrab(hit)) {
      this.#touching = false;
      return;
    }

    // 掴んでいるあいだ地図を動かさない。
    event.preventDefault();

    if (hit.role === 'ghost') {
      this.#vertices.splice(hit.index + 1, 0, this.#edgeMidpoint(hit.index));
      this.#dragging = hit.index + 1;
    } else {
      this.#dragging = hit.index;
    }

    this.#selected = this.#dragging;
    this.#dragMoved = false;
    this.#map.on('touchmove', this.#handleTouchMove);
    this.#map.once('touchend', this.#handleTouchEnd);
    this.#map.once('touchcancel', this.#handleTouchEnd);
    this.#commitVertices();
  };

  /**
   * その当たりを掴めるか。
   *
   * 確定後はどれでも掴める。継ぎ足している最中（線を描いている途中）は、すでに置いた頂点だけ。
   * 面の描画中に掴ませると、開始点をクリックして閉じる操作と取り合いになる。
   */
  #canGrab(hit: { role: 'vertex' | 'ghost'; index: number }): boolean {
    if (this.#phase === 'editing') return true;
    return this.#kind === 'line' && hit.role === 'vertex';
  }

  #handleTouchMove = (event: MapTouchEvent): void => {
    if (this.#dragging === null) return;
    event.preventDefault();
    this.#dragMoved = true;
    this.#vertices[this.#dragging] = event.lngLat.toArray();
    this.#commitVertices(true);
  };

  #handleTouchEnd = (): void => {
    this.#map.off('touchmove', this.#handleTouchMove);
    this.#touching = false;
    if (this.#dragging === null) return;
    this.#dragging = null;
    this.#render();
  };

  #handleDragMove = (event: MapMouseEvent): void => {
    if (this.#dragging === null) return;

    // ウィンドウの外でボタンを離された場合は mouseup が来ないので、ここで気づく。
    if (event.originalEvent.buttons === 0) {
      this.#handleDragEnd();
      return;
    }

    this.#dragMoved = true;
    this.#vertices[this.#dragging] = event.lngLat.toArray();
    this.#commitVertices(true);
  };

  #handleDragEnd = (): void => {
    if (this.#dragging === null) return;
    // 掴んだだけで動いていないなら、その click は掴む前と同じ意味（確定や点の追加）を持つ。
    this.#swallowNextClick = this.#phase === 'drawing' && this.#dragMoved;
    this.#endDrag();
    this.#render();
  };

  #endDrag(): void {
    this.#map.off('mousemove', this.#handleDragMove);
    this.#map.off('touchmove', this.#handleTouchMove);
    window.removeEventListener('mouseup', this.#handleDragEnd);
    this.#dragging = null;
  }

  #handleContextMenu = (event: MapMouseEvent): void => {
    if (this.#phase !== 'editing' || this.#dragging !== null) return;
    const hit = this.#hitTest(event.point);
    if (hit?.role !== 'vertex') return;
    event.preventDefault();
    this.#deleteVertex(hit.index);
  };

  #handleZoomEnd = (): void => {
    if (this.#phase === 'editing') this.#requestRender();
  };

  /** 頂点を削除する。種類ごとの最小の数を下回る削除はしない。 */
  #deleteVertex(index: number): void {
    // ドラッグ中に消すと #dragging の指す番号がずれて、別の頂点が動き出す。
    if (this.#dragging !== null || !this.#canDeleteVertex()) return;
    this.#vertices.splice(index, 1);

    if (this.#selected === index) this.#selected = null;
    else if (this.#selected !== null && this.#selected > index) this.#selected -= 1;

    this.#commitVertices();
  }

  #canDeleteVertex(): boolean {
    return this.#vertices.length > MIN_VERTICES[this.#kind];
  }

  /** 辺の数。面は端どうしも繋がるが、線は繋がらない。 */
  #edgeCount(): number {
    const count = this.#vertices.length;
    if (this.#kind === 'polygon') return count;
    return Math.max(0, count - 1);
  }

  /** 辺 i の中点。辺 i は頂点 i と i+1（面では末尾の次は先頭）を結ぶ。 */
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
    for (let index = 0; index < this.#edgeCount(); index += 1) {
      const from = this.#map.project(vertices[index]!);
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
    let best = this.#touching ? TOUCH_HIT_PIXELS : HIT_PIXELS;

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
    if (this.#phase === 'editing') {
      if (this.#dragging !== null) return;
      const hit = this.#hitTest(event.point);
      this.#setCursor(hit === null ? '' : hit.role === 'ghost' ? 'copy' : 'move');
      return;
    }

    this.#setCursor(
      this.#kind === 'polygon' && this.#canClose() && this.#isNearFirstVertex(event.point)
        ? 'pointer'
        : 'crosshair'
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
    // 入力欄やボタンにフォーカスがあるときは譲る。Enter がクリックに化けるし、
    // 名前を打っているあいだの Backspace で頂点が消えては困る。
    if (isTyping(event.target)) return;

    if (this.#phase === 'editing') {
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
    if (event.key === 'Escape') this.begin(this.#kind, this.#color);
  };

  #setCursor(cursor: string): void {
    const canvas = this.#map.getCanvas();
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }

  // MARK: - 描画の反映

  /** 頂点を変えたあとの後始末。面積・長さ・交差を計算し直して再描画する。 */
  #commitVertices(coalesce = false): void {
    const closed = this.#canClose();
    this.#areaSquareMeters =
      this.#kind === 'polygon' && closed ? polygonArea(this.#vertices) : null;
    this.#totalMeters = this.#kind === 'line' && closed ? lineLength(this.#vertices) : null;
    this.#selfIntersecting = this.#kind === 'polygon' && isSelfIntersecting(this.#vertices);
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
      kind: this.#kind,
      phase: this.#phase,
      canResume: this.canResume,
      vertexCount: this.#vertices.length,
      selectedVertex: this.#selected,
      areaSquareMeters: this.#areaSquareMeters,
      totalMeters: this.#totalMeters,
      canDeleteVertex: this.#canDeleteVertex(),
      selfIntersecting: this.#selfIntersecting,
    });
  }

  #buildCollection(): FeatureCollection {
    const vertices = this.#vertices;
    const editing = this.#phase === 'editing';

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

      if (this.#kind === 'polygon') {
        features.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [toRing(vertices)] },
          properties: {},
        });
      } else if (this.#kind === 'line') {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: vertices },
          properties: {},
        });
      }
    } else {
      // 確定前は、最後の頂点からカーソルまでを繋いだ折れ線を見せる。
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

  /** 色は item ごとに変わる。レイヤーを作り直さず、塗りだけ差し替える。 */
  #applyColor(): void {
    this.#map.setPaintProperty(EDIT_FILL_LAYER_ID, 'fill-color', this.#color);
    this.#map.setPaintProperty(EDIT_LINE_LAYER_ID, 'line-color', this.#color);
    // 計測は破線。田んぼの輪郭（実線）と、測っている線をひと目で見分けられる。
    // 縁取りも同じ間隔で切る。片方だけ実線だと、黒い線が通って破線に見えない。
    const line = this.#kind === 'line';
    this.#map.setPaintProperty(EDIT_LINE_LAYER_ID, 'line-width', line ? MEASURE_WIDTH : 2);
    this.#map.setPaintProperty(EDIT_LINE_LAYER_ID, 'line-dasharray', line ? MEASURE_DASH : undefined);
    this.#map.setPaintProperty(
      EDIT_CASING_LAYER_ID,
      'line-dasharray',
      line ? MEASURE_CASING_DASH : undefined
    );
    this.#map.setPaintProperty(EDIT_VERTEX_LAYER_ID, 'circle-color', [
      'case',
      ['==', ['get', 'selected'], true],
      this.#color,
      '#ffffff',
    ]);
    this.#map.setPaintProperty(EDIT_VERTEX_LAYER_ID, 'circle-stroke-color', [
      'case',
      ['==', ['get', 'selected'], true],
      '#ffffff',
      this.#color,
    ]);
  }

  #addLayers(): GeoJSONSource {
    this.#map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY_COLLECTION });

    this.#map.addLayer({
      id: EDIT_FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': this.#color, 'fill-opacity': 0.25 },
    });

    // 計測の線は写真の上では細くて見失う。暗い縁取りを下に敷く。
    this.#map.addLayer({
      id: EDIT_CASING_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#1d1d1f',
        'line-opacity': 0.55,
        'line-width': MEASURE_CASING_WIDTH,
      },
    });

    this.#map.addLayer({
      id: EDIT_LINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': this.#color, 'line-width': 2 },
    });

    this.#map.addLayer({
      id: EDIT_VERTEX_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        // ゴーストは「まだ頂点ではない」ことが見て分かるよう、小さく薄くする。
        'circle-radius': ['match', ['get', 'role'], 'start', 6, 'ghost', 3.5, 5],
        // ゴーストには selected を持たせていないので、== で null を false に落とす。
        'circle-color': ['case', ['==', ['get', 'selected'], true], this.#color, '#ffffff'],
        'circle-opacity': ['match', ['get', 'role'], 'ghost', 0.5, 1],
        'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], '#ffffff', this.#color],
        'circle-stroke-width': ['match', ['get', 'role'], 'ghost', 1.5, 2],
        'circle-stroke-opacity': ['match', ['get', 'role'], 'ghost', 0.5, 1],
      },
    });

    return this.#map.getSource(SOURCE_ID) as GeoJSONSource;
  }
}
