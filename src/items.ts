import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { isIconName, type IconName } from './icons';
import {
  isSelfIntersecting,
  lineLength,
  polygonArea,
  toCounterClockwiseRing,
  toRing,
  type Vertex,
} from './geometry';

/**
 * 地図に置くものを 1 つの型でまとめて持つ。田んぼ・計測・ピンは、
 * 形（面・線・点）と既定の色が違うだけで、名前を付けて一覧に並べて表示を切る点は同じ。
 *
 * 保存も書き出しも同じ GeoJSON。ジオメトリの種類で見分けられるので、
 * 田んぼだけを書き出していた頃のファイルもそのまま読める。
 */

const STORAGE_KEY = 'tanbo-map.paddies';

export type ItemKind = 'paddy' | 'measure' | 'pin';

export interface Item {
  id: string;
  kind: ItemKind;
  name: string;
  /** #rrggbb。地図の塗り・線・ピンの色。 */
  color: string;
  /** 地図に出すか。一覧のトグルで切り替え、保存にも残す。 */
  visible: boolean;
  /** pin のときだけ持つ。 */
  icon?: IconName;
  /** paddy: 閉じないリング（3 点以上）/ measure: 折れ線（2 点以上）/ pin: 1 点。 */
  vertices: Vertex[];
}

export class ImportError extends Error {}

const DEFAULT_COLORS: Record<ItemKind, string> = {
  paddy: '#ffb300',
  measure: '#ffffff',
  pin: '#0071e3',
};

/** 種類の呼び名。名前の頭にも、インスペクタの見出しにも使う。 */
const KIND_LABEL: Record<ItemKind, string> = {
  paddy: '田んぼ',
  measure: '計測',
  pin: 'ピン',
};

export function kindLabel(kind: ItemKind): string {
  return KIND_LABEL[kind];
}

const MIN_VERTICES: Record<ItemKind, number> = { paddy: 3, measure: 2, pin: 1 };

export const DEFAULT_ICON: IconName = 'location_on';

/** 種類ごとの記号。ピンは選んだアイコンをそのまま使う。 */
const KIND_ICON: Record<ItemKind, IconName> = {
  paddy: 'crop_free',
  measure: 'straighten',
  pin: DEFAULT_ICON,
};

/** 一覧の行にもパネルの見出しにも、同じ記号を出す。 */
export function itemIcon(item: Item): IconName {
  return item.kind === 'pin' ? (item.icon ?? DEFAULT_ICON) : KIND_ICON[item.kind];
}

export function defaultColor(kind: ItemKind): string {
  return DEFAULT_COLORS[kind];
}

export function minVertices(kind: ItemKind): number {
  return MIN_VERTICES[kind];
}

/**
 * `crypto.randomUUID` は secure context でしか生えない。
 * `vite --host` で LAN の IP を開くと http になるので、そこでも動くようにしておく。
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 面積（㎡）。田んぼ以外は面にならないので null。 */
export function itemArea(item: Item): number | null {
  return item.kind === 'paddy' ? polygonArea(item.vertices) : null;
}

/** 全長（m）。計測以外は null。 */
export function itemLength(item: Item): number | null {
  return item.kind === 'measure' ? lineLength(item.vertices) : null;
}

/** 輪郭が交差している田んぼの面積は当てにならない。一覧でも書き出しでも数値を出さない。 */
export function isItemReliable(item: Item): boolean {
  return item.kind !== 'paddy' || !isSelfIntersecting(item.vertices);
}

/** 「田んぼ 3」のように、種類ごとに既存とぶつからない番号を振る。 */
export function nextName(items: Item[], kind: ItemKind): string {
  const used = new Set(items.map((item) => item.name));
  for (let number = 1; ; number += 1) {
    const name = `${KIND_LABEL[kind]} ${number}`;
    if (!used.has(name)) return name;
  }
}

export function newItem(kind: ItemKind, vertices: Vertex[], existing: Item[]): Item {
  return {
    id: newId(),
    kind,
    name: nextName(existing, kind),
    color: defaultColor(kind),
    visible: true,
    ...(kind === 'pin' ? { icon: DEFAULT_ICON } : {}),
    vertices,
  };
}

function geometryOf(item: Item, counterClockwise: boolean): Geometry {
  if (item.kind === 'pin') return { type: 'Point', coordinates: item.vertices[0] as Position };
  if (item.kind === 'measure') {
    return { type: 'LineString', coordinates: item.vertices.map((vertex) => vertex as Position) };
  }
  return {
    type: 'Polygon',
    coordinates: [counterClockwise ? toCounterClockwiseRing(item.vertices) : toRing(item.vertices)],
  };
}

/** 保存と書き出しに使う GeoJSON。名前・色・表示の有無まで載せる。 */
export function toGeoJSON(items: Item[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: items.map((item) => {
      const reliable = isItemReliable(item);
      const areaSquareMeters = itemArea(item);
      const lengthMeters = itemLength(item);
      return {
        type: 'Feature',
        id: item.id,
        geometry: geometryOf(item, true),
        properties: {
          kind: item.kind,
          name: item.name,
          color: item.color,
          visible: item.visible,
          ...(item.icon === undefined ? {} : { icon: item.icon }),
          // 交差した輪郭に面積を書くと、受け取った側は正しい数値だと思ってしまう。
          ...(areaSquareMeters === null
            ? {}
            : {
                areaSquareMeters: reliable ? Math.round(areaSquareMeters) : null,
                selfIntersecting: !reliable,
              }),
          ...(lengthMeters === null ? {} : { lengthMeters: Math.round(lengthMeters) }),
        },
      } satisfies Feature;
    }),
  };
}

/**
 * 地図に出すための GeoJSON。塗りと線の色をデータで持たせ、選択中かどうかも焼き込む。
 * 隠しているものと、編集中で別に描かれているものは外す。
 */
export function toMapGeoJSON(
  items: Item[],
  selectedId: string | null,
  editingId: string | null
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: items
      .filter((item) => item.visible && item.id !== editingId && item.kind !== 'pin')
      .map((item) => ({
        type: 'Feature',
        id: item.id,
        geometry: geometryOf(item, false),
        properties: {
          id: item.id,
          kind: item.kind,
          color: item.color,
          selected: item.id === selectedId,
        },
      })),
  };
}

function isVertex(value: unknown): value is Vertex {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function toVertices(value: unknown): Vertex[] | null {
  if (!Array.isArray(value) || !value.every(isVertex)) return null;
  return value.map(([lng, lat]) => [lng, lat] satisfies Vertex);
}

/** リングの末尾が先頭と同じなら落とす。3 頂点に満たないものは面にならない。 */
function ringToVertices(ring: unknown): Vertex[] | null {
  const vertices = toVertices(ring);
  if (vertices === null) return null;

  const first = vertices[0];
  const last = vertices.at(-1);
  if (first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]) {
    vertices.pop();
  }
  return vertices.length >= 3 ? vertices : null;
}

interface Shape {
  kind: ItemKind;
  vertices: Vertex[];
}

/**
 * 1 つの feature から取れるだけの形を取る。
 * 穴あきポリゴンは外周だけを使い、Multi 系は 1 つずつに割る（QGIS の書き出しは
 * MultiPolygon になることが多い）。
 *
 * 種類はジオメトリで決める。`properties.kind` が食い違っていても、描けるのは形のほうなので。
 */
function featureToShapes(feature: Feature): Shape[] {
  const geometry = feature?.geometry;
  const polygons = (rings: unknown[]): Shape[] =>
    rings
      .map((ring) => ringToVertices(ring))
      .filter((vertices) => vertices !== null)
      .map((vertices) => ({ kind: 'paddy' as const, vertices }));

  switch (geometry?.type) {
    case 'Polygon':
      return polygons([geometry.coordinates[0]]);
    case 'MultiPolygon':
      return polygons(geometry.coordinates.map((polygon) => polygon[0]));
    case 'LineString': {
      const vertices = toVertices(geometry.coordinates);
      return vertices !== null && vertices.length >= 2 ? [{ kind: 'measure', vertices }] : [];
    }
    case 'MultiLineString':
      return geometry.coordinates
        .map((line) => toVertices(line))
        .filter((vertices) => vertices !== null && vertices.length >= 2)
        .map((vertices) => ({ kind: 'measure' as const, vertices: vertices as Vertex[] }));
    case 'Point': {
      const vertices = toVertices([geometry.coordinates]);
      return vertices === null ? [] : [{ kind: 'pin', vertices }];
    }
    case 'MultiPoint': {
      const vertices = toVertices(geometry.coordinates);
      return vertices === null ? [] : vertices.map((vertex) => ({ kind: 'pin' as const, vertices: [vertex] }));
    }
    default:
      return [];
  }
}

/** `#rrggbb` でなければ既定色に落とす。壊れた属性で起動できなくなるほうが困る。 */
function readColor(value: unknown, kind: ItemKind): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : defaultColor(kind);
}

/**
 * GeoJSON を読み込む。取り込めなかった feature は黙って捨てず、件数で知らせる。
 * 1 つも取れなければ ImportError。id は必ず一意にして返す。
 */
export function fromGeoJSON(text: string): { items: Item[]; skipped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('GeoJSON として読めませんでした');
  }

  const collection = parsed as FeatureCollection;
  const features = Array.isArray(collection?.features) ? collection.features : null;
  if (features === null) throw new ImportError('FeatureCollection ではありません');

  const items: Item[] = [];
  const ids = new Set<string>();
  let skipped = 0;

  for (const feature of features) {
    const shapes = featureToShapes(feature);
    if (shapes.length === 0) {
      skipped += 1;
      continue;
    }

    const properties = feature?.properties ?? {};
    const name = properties['name'];
    const icon = properties['icon'];
    for (const [index, shape] of shapes.entries()) {
      // 同じ id が 2 つ並ぶと、1 つを消したつもりで両方消える。
      const wanted = typeof feature.id === 'string' && index === 0 ? feature.id : '';
      const id = wanted !== '' && !ids.has(wanted) ? wanted : newId();
      ids.add(id);
      const wantedName = typeof name === 'string' && name !== '' && index === 0 ? name : '';
      items.push({
        id,
        kind: shape.kind,
        name: wantedName !== '' ? wantedName : nextName(items, shape.kind),
        color: readColor(properties['color'], shape.kind),
        // 保存されていなければ出す。隠されたまま戻ってくるより、出ているほうが気づける。
        visible: properties['visible'] !== false,
        ...(shape.kind === 'pin' ? { icon: isIconName(icon) ? icon : DEFAULT_ICON } : {}),
        vertices: shape.vertices,
      });
    }
  }

  if (items.length === 0) throw new ImportError('取り込めるものがありませんでした');
  return { items, skipped };
}

/**
 * 取り込んだものを既存に足す。
 * id が重なったまま並ぶと、1 つを削除したつもりで同じ id の別のものまで消える。
 * 同じファイルを 2 回読み込んでも別々のものとして扱えるよう、衝突分は振り直す。
 */
export function merge(existing: Item[], incoming: Item[]): Item[] {
  const merged = [...existing];
  const ids = new Set(existing.map((item) => item.id));

  for (const item of incoming) {
    const id = ids.has(item.id) ? newId() : item.id;
    ids.add(id);
    const nameTaken = merged.some((other) => other.name === item.name);
    merged.push({ ...item, id, name: nameTaken ? nextName(merged, item.kind) : item.name });
  }
  return merged;
}

export function loadStored(): Item[] {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Cookie を全面的にブロックしている環境では、参照そのものが例外になる。
    return [];
  }
  if (text === null) return [];

  try {
    return merge([], fromGeoJSON(text).items);
  } catch {
    // 壊れた保存内容で起動できなくなるより、捨てて始めるほうがまし。
    return [];
  }
}

/** 保存できたかを返す。書けないまま「保存済み」と見せないため、失敗は呼び出し側に伝える。 */
export function store(items: Item[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toGeoJSON(items)));
    return true;
  } catch {
    return false;
  }
}
