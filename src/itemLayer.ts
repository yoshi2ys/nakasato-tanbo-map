import { GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { MEASURE_DASH } from './editor';
import { toMapGeoJSON, type Item } from './items';

const SOURCE_ID = 'tanbo-items';
export const ITEM_FILL_LAYER_ID = 'tanbo-items-fill';
export const ITEM_CASING_LAYER_ID = 'tanbo-items-casing';
export const ITEM_LINE_LAYER_ID = 'tanbo-items-line';
export const ITEM_MEASURE_LAYER_ID = 'tanbo-items-measure';

const EMPTY = { type: 'FeatureCollection' as const, features: [] };

/**
 * 保存してあるものを地図に出す。田んぼは面、計測は線。ピンは Marker なのでここには来ない。
 *
 * 色は feature の属性から引く。レイヤーごとに固定の色を塗ると、item ごとに色を変えられない。
 * 隠しているものと編集中のものは、そもそも feature を作らない（レイヤーの visibility は
 * 全部まとめてしか切れないので、1 つだけ隠す用途には使えない）。
 */
export class ItemLayer {
  readonly #map: MapLibreMap;
  readonly #source: GeoJSONSource;

  constructor(map: MapLibreMap, beforeLayerId: string) {
    this.#map = map;
    map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY });

    map.addLayer(
      {
        id: ITEM_FILL_LAYER_ID,
        type: 'fill',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': ['get', 'color'],
          // 選択中は少し濃くする。色そのものは変えない（一覧と地図で別の色に見えてしまう）。
          'fill-opacity': ['case', ['get', 'selected'], 0.3, 0.16],
        },
      },
      beforeLayerId
    );
    // 計測の線は写真の上では細くて見失う。暗い縁取りを下に敷く。
    map.addLayer(
      {
        id: ITEM_CASING_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1d1d1f', 'line-opacity': 0.55, 'line-width': 6 },
      },
      beforeLayerId
    );
    map.addLayer(
      {
        id: ITEM_LINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Polygon'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'selected'], 3.5, 2],
        },
      },
      beforeLayerId
    );
    /*
     * 計測は破線。田んぼの輪郭と同じ実線だと、囲ったのか測ったのかが見分けにくい。
     * line-dasharray は属性で変えられないので、線だけ別のレイヤーに分けてある。
     */
    map.addLayer(
      {
        id: ITEM_MEASURE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'selected'], 3.5, 2],
          'line-dasharray': MEASURE_DASH,
        },
      },
      beforeLayerId
    );

    this.#source = map.getSource(SOURCE_ID) as GeoJSONSource;
  }

  setItems(items: Item[], selectedId: string | null, editingId: string | null): void {
    this.#source.setData(toMapGeoJSON(items, selectedId, editingId));
  }

  /** 自動検出が写真だけを読めるよう、描いたものを一時的に隠す。 */
  setVisible(visible: boolean): void {
    const visibility = visible ? 'visible' : 'none';
    for (const id of [
      ITEM_FILL_LAYER_ID,
      ITEM_CASING_LAYER_ID,
      ITEM_LINE_LAYER_ID,
      ITEM_MEASURE_LAYER_ID,
    ]) {
      this.#map.setLayoutProperty(id, 'visibility', visibility);
    }
  }
}
