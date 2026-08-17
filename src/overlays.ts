import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Settings } from './settings';
import { cachedTileUrl, type TileSource } from './tileCache';

/**
 * 航空写真の上に重ねる地図。道の名前や地形を読みたいときに出す。
 *
 * 地理院タイルはどれも出典の表示が要る。ただしソースに attribution を持たせると
 * 出していないあいだも表記が並ぶので、設定画面にまとめて書いてある。
 */

export type OverlayId = 'std' | 'pale' | 'hillshade';

export const OVERLAY_IDS: OverlayId[] = ['std', 'pale', 'hillshade'];

export interface OverlayDefinition {
  id: OverlayId;
  label: string;
  url: string;
  /** 配信されている一番深いズーム。これより寄ると引き伸ばしになる。 */
  maxZoom: number;
}

/** 十日町の座標で実際に取れることを確かめた配信。 */
export const OVERLAYS: OverlayDefinition[] = [
  {
    id: 'std',
    label: '標準地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    maxZoom: 18,
  },
  {
    id: 'pale',
    label: '淡色地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    maxZoom: 18,
  },
  {
    id: 'hillshade',
    label: '陰影起伏',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png',
    maxZoom: 16,
  },
];

const TILE_SIZE = 256;

export function overlaySourceId(id: OverlayId): string {
  return `overlay-${id}`;
}

export function overlayLayerId(id: OverlayId): string {
  return `overlay-${id}`;
}

/** 重ねる地図のレイヤー ID（下から順）。自動検出のときはまとめて隠す。 */
export const OVERLAY_LAYER_IDS = OVERLAYS.map((overlay) => overlayLayerId(overlay.id));

/**
 * 写真の上、描いたものの下に 3 枚とも置く。
 * 出し入れは visibility で切り替える。あとから addSource すると重ね順の管理が崩れるので、
 * 使わないものも最初から置いておく。
 */
export function addOverlayLayers(map: MapLibreMap, beforeId?: string): void {
  for (const overlay of OVERLAYS) {
    map.addSource(overlaySourceId(overlay.id), {
      type: 'raster',
      tiles: [cachedTileUrl(overlay.url)],
      tileSize: TILE_SIZE,
      maxzoom: overlay.maxZoom,
    });
    map.addLayer(
      {
        id: overlayLayerId(overlay.id),
        type: 'raster',
        source: overlaySourceId(overlay.id),
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.5 },
      },
      beforeId
    );
  }
}

export function applyOverlaySettings(map: MapLibreMap, settings: Settings): void {
  for (const overlay of OVERLAYS) {
    const setting = settings.overlays[overlay.id];
    const layerId = overlayLayerId(overlay.id);
    if (map.getLayer(layerId) === undefined) continue;
    map.setLayoutProperty(layerId, 'visibility', setting.on ? 'visible' : 'none');
    map.setPaintProperty(layerId, 'raster-opacity', setting.opacity);
  }
}

/** オフラインにためる対象。出していない地図まで落とすと、枚数が何倍にもなる。 */
export function overlayTileSources(settings: Settings): TileSource[] {
  return OVERLAYS.filter((overlay) => settings.overlays[overlay.id].on).map((overlay) => ({
    url: overlay.url,
    maxZoom: overlay.maxZoom,
    tileSize: TILE_SIZE,
  }));
}
