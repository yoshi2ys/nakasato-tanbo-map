import { area } from '@turf/area';
import { distance } from '@turf/distance';
import type { Position } from 'geojson';

/**
 * 座標だけの計算。地図にも DOM にも依存しない。
 *
 * ここが分かれていないと、モデル（田んぼや計測）が描画のモジュールを読むことになり、
 * 参照の向きが逆になる。
 */

export type Vertex = [lng: number, lat: number];

/** 頂点リストを閉じたリング（先頭 = 末尾）にする。turf は自動で閉じない。 */
export function toRing(vertices: Vertex[]): Position[] {
  return [...vertices, vertices[0]!];
}

/**
 * RFC 7946 が求める反時計回りの外周リングにする。
 * 符号付き面積が正なら時計回りなので、向きを反転してから閉じる。
 */
export function toCounterClockwiseRing(vertices: Vertex[]): Position[] {
  // この式（台形則）は時計回りで正になる。外積の総和とは符号が逆なので、混ぜない。
  let doubleArea = 0;
  for (const [index, [lng, lat]] of vertices.entries()) {
    const [nextLng, nextLat] = vertices[(index + 1) % vertices.length]!;
    doubleArea += (nextLng - lng) * (nextLat + lat);
  }
  return toRing(doubleArea > 0 ? [...vertices].reverse() : vertices);
}

/** 田んぼ 1 枚のスケールでは、中点は緯度経度の単純平均で十分。 */
export function midpoint(a: Vertex, b: Vertex): Vertex {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** 輪郭の面積（㎡）。交差しているリングでも黙って値を返すので、呼ぶ前に確かめる。 */
export function polygonArea(vertices: Vertex[]): number {
  return area({ type: 'Polygon', coordinates: [toRing(vertices)] });
}

/** 2 点間の距離（m）。 */
export function segmentLength(from: Vertex, to: Vertex): number {
  return distance(from, to, { units: 'meters' });
}

/** 折れ線の全長（m）。 */
export function lineLength(vertices: Vertex[]): number {
  let total = 0;
  for (let i = 1; i < vertices.length; i += 1) total += segmentLength(vertices[i - 1]!, vertices[i]!);
  return total;
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
