import { area } from '@turf/area';
import type { Feature, FeatureCollection, Polygon, Position } from 'geojson';
import { isSelfIntersecting, type Vertex } from './draw';

const STORAGE_KEY = 'tanbo-map.paddies';

export interface Paddy {
  id: string;
  name: string;
  vertices: Vertex[];
}

export class ImportError extends Error {}

/**
 * `crypto.randomUUID` は secure context でしか生えない。
 * `vite --host` で LAN の IP を開くと http になるので、そこでも動くようにしておく。
 */
function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** GeoJSON のリングは先頭と末尾が同じ点でなければならない。 */
function toRing(vertices: Vertex[]): Position[] {
  return [...vertices, vertices[0]!];
}

/**
 * RFC 7946 は外周リングを反時計回りと定めている。描いた順のままだと時計回りになりうるので、
 * 書き出す前に向きを揃える。巻き方向を意味として読む地図ソフトで、裏返って解釈されるのを防ぐ。
 */
function toCounterClockwiseRing(vertices: Vertex[]): Position[] {
  let doubleArea = 0;
  for (const [index, [lng, lat]] of vertices.entries()) {
    const [nextLng, nextLat] = vertices[(index + 1) % vertices.length]!;
    doubleArea += (nextLng - lng) * (nextLat + lat);
  }
  return toRing(doubleArea > 0 ? [...vertices].reverse() : vertices);
}

export function paddyArea(paddy: Paddy): number {
  return area({ type: 'Polygon', coordinates: [toRing(paddy.vertices)] });
}

/** 輪郭が交差している田んぼの面積は当てにならない。一覧でも書き出しでも数値を出さない。 */
export function isPaddyReliable(paddy: Paddy): boolean {
  return !isSelfIntersecting(paddy.vertices);
}

/** 「田んぼ 3」のように、既存とぶつからない番号を振る。 */
export function nextName(paddies: Paddy[]): string {
  const used = new Set(paddies.map((paddy) => paddy.name));
  for (let number = 1; ; number += 1) {
    const name = `田んぼ ${number}`;
    if (!used.has(name)) return name;
  }
}

export function toGeoJSON(paddies: Paddy[]): FeatureCollection<Polygon> {
  return {
    type: 'FeatureCollection',
    features: paddies.map((paddy) => {
      const reliable = isPaddyReliable(paddy);
      return {
        type: 'Feature',
        id: paddy.id,
        geometry: { type: 'Polygon', coordinates: [toCounterClockwiseRing(paddy.vertices)] },
        properties: {
          name: paddy.name,
          // 交差した輪郭に面積を書くと、受け取った側は正しい数値だと思ってしまう。
          areaSquareMeters: reliable ? Math.round(paddyArea(paddy)) : null,
          selfIntersecting: !reliable,
        },
      };
    }),
  };
}

/** 地図に出すためだけの GeoJSON。名前も面積も要らないので、面積計算を挟まない。 */
export function toGeometryOnlyGeoJSON(paddies: Paddy[]): FeatureCollection<Polygon> {
  return {
    type: 'FeatureCollection',
    features: paddies.map((paddy) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [toRing(paddy.vertices)] },
      properties: {},
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

/** リングの末尾が先頭と同じなら落とす。3 頂点に満たないものは面にならない。 */
function ringToVertices(ring: unknown): Vertex[] | null {
  if (!Array.isArray(ring) || !ring.every(isVertex)) return null;

  const vertices = ring.map(([lng, lat]) => [lng, lat] satisfies Vertex);
  const first = vertices[0];
  const last = vertices.at(-1);
  if (first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]) {
    vertices.pop();
  }
  return vertices.length >= 3 ? vertices : null;
}

/**
 * 1 つの feature から取れるだけの輪郭を取る。
 * 穴あきポリゴンは外周だけを使い、MultiPolygon は 1 枚ずつに割る（QGIS の書き出しは
 * MultiPolygon になることが多い）。
 */
function featureToVertices(feature: Feature): Vertex[][] {
  const geometry = feature?.geometry;
  if (geometry?.type === 'Polygon') {
    const vertices = ringToVertices(geometry.coordinates[0]);
    return vertices === null ? [] : [vertices];
  }
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates
      .map((polygon) => ringToVertices(polygon[0]))
      .filter((vertices) => vertices !== null);
  }
  return [];
}

/**
 * GeoJSON を読み込む。取り込めなかった feature は黙って捨てず、件数で知らせる。
 * 1 枚も取れなければ ImportError。id は必ず一意にして返す。
 */
export function fromGeoJSON(text: string): { paddies: Paddy[]; skipped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('GeoJSON として読めませんでした');
  }

  const collection = parsed as FeatureCollection;
  const features = Array.isArray(collection?.features) ? collection.features : null;
  if (features === null) throw new ImportError('FeatureCollection ではありません');

  const paddies: Paddy[] = [];
  const ids = new Set<string>();
  let skipped = 0;

  for (const feature of features) {
    const outlines = featureToVertices(feature);
    if (outlines.length === 0) {
      skipped += 1;
      continue;
    }

    const name = feature?.properties?.['name'];
    for (const [index, vertices] of outlines.entries()) {
      // 同じ id が 2 枚並ぶと、1 枚を消したつもりで両方消える。
      const wanted = typeof feature.id === 'string' && index === 0 ? feature.id : '';
      const id = wanted !== '' && !ids.has(wanted) ? wanted : newId();
      ids.add(id);
      const wantedName = typeof name === 'string' && name !== '' && index === 0 ? name : '';
      paddies.push({
        id,
        name: wantedName !== '' ? wantedName : nextName(paddies),
        vertices,
      });
    }
  }

  if (paddies.length === 0) throw new ImportError('取り込める田んぼがありませんでした');
  return { paddies, skipped };
}

/**
 * 取り込んだ田んぼを既存に足す。
 * id が重なったまま並ぶと、1 枚を削除したつもりで同じ id の別の枚まで消える。
 * 同じファイルを 2 回読み込んでも別々の 1 枚として扱えるよう、衝突分は振り直す。
 */
export function merge(existing: Paddy[], incoming: Paddy[]): Paddy[] {
  const merged = [...existing];
  const ids = new Set(existing.map((paddy) => paddy.id));

  for (const paddy of incoming) {
    const id = ids.has(paddy.id) ? newId() : paddy.id;
    ids.add(id);
    const nameTaken = merged.some((other) => other.name === paddy.name);
    merged.push({ ...paddy, id, name: nameTaken ? nextName(merged) : paddy.name });
  }
  return merged;
}

export function newPaddy(vertices: Vertex[], existing: Paddy[]): Paddy {
  return { id: newId(), name: nextName(existing), vertices };
}

export function loadStored(): Paddy[] {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Cookie を全面的にブロックしている環境では、参照そのものが例外になる。
    return [];
  }
  if (text === null) return [];

  try {
    return merge([], fromGeoJSON(text).paddies);
  } catch {
    // 壊れた保存内容で起動できなくなるより、捨てて始めるほうがまし。
    return [];
  }
}

/** 保存できたかを返す。書けないまま「保存済み」と見せないため、失敗は呼び出し側に伝える。 */
export function store(paddies: Paddy[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toGeoJSON(paddies)));
    return true;
  } catch {
    return false;
  }
}
