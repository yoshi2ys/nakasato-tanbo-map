import { GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { toGeometryOnlyGeoJSON, type Paddy } from './paddies';

const SOURCE_ID = 'tanbo-saved';
const FILL_LAYER_ID = 'tanbo-saved-fill';
const LINE_LAYER_ID = 'tanbo-saved-line';

const EMPTY = { type: 'FeatureCollection' as const, features: [] };

/**
 * 編集中でない田んぼを地図に出す。
 * 編集中の 1 枚は PolygonDrawer が描くので、こちらは常にそれを除いた分だけを持つ。
 * 描画専用で、クリックは受け取らない（選択は一覧から行う）。
 */
export class SavedPaddyLayer {
  readonly #map: MapLibreMap;
  readonly #source: GeoJSONSource;

  constructor(map: MapLibreMap, beforeLayerId: string) {
    this.#map = map;
    map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY });

    // 編集中のポリゴンの下に敷く。
    map.addLayer(
      {
        id: FILL_LAYER_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: { 'fill-color': '#ffb300', 'fill-opacity': 0.18 },
      },
      beforeLayerId
    );
    map.addLayer(
      {
        id: LINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffb300', 'line-width': 2 },
      },
      beforeLayerId
    );

    this.#source = map.getSource(SOURCE_ID) as GeoJSONSource;
  }

  setPaddies(paddies: Paddy[]): void {
    this.#source.setData(paddies.length === 0 ? EMPTY : toGeometryOnlyGeoJSON(paddies));
  }

  /** 自動検出が写真だけを読めるよう、保存済みの輪郭も一時的に隠す。 */
  setVisible(visible: boolean): void {
    const visibility = visible ? 'visible' : 'none';
    for (const id of [FILL_LAYER_ID, LINE_LAYER_ID]) {
      this.#map.setLayoutProperty(id, 'visibility', visibility);
    }
  }
}
