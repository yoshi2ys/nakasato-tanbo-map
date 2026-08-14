import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// maplibre-gl は worker を「自分自身の import.meta.url の兄弟ファイル」として実行時に
// 解決するため、バンドラは worker を出力できない。Vite に出力させた URL を明示的に渡す。
setWorkerUrl(workerUrl);

/** 国土地理院「全国最新写真（シームレス）」タイル。API キー不要、出典表記が必須。 */
const SEAMLESSPHOTO_TILE_URL =
  'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
const SEAMLESSPHOTO_MAX_ZOOM = 18;
const SEAMLESSPHOTO_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院 全国最新写真（シームレス）</a>';

/** 初期表示位置（新潟市南区の水田地帯）。 */
const INITIAL_CENTER: [number, number] = [139.033, 37.78];
const INITIAL_ZOOM = 17;

export function createMap(container: HTMLElement): MapLibreMap {
  const map = new MapLibreMap({
    container,
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
    // タイルは 18 までなので、それ以上はオーバーズームで拡大表示する。
    maxZoom: 21,
    // 頂点編集で誤操作しないよう、回転・傾斜は無効にしておく。
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: false,
    style: {
      version: 8,
      sources: {
        seamlessphoto: {
          type: 'raster',
          tiles: [SEAMLESSPHOTO_TILE_URL],
          tileSize: 256,
          maxzoom: SEAMLESSPHOTO_MAX_ZOOM,
          attribution: SEAMLESSPHOTO_ATTRIBUTION,
        },
      },
      layers: [
        {
          id: 'seamlessphoto',
          type: 'raster',
          source: 'seamlessphoto',
        },
      ],
    },
  });

  map.touchZoomRotate.disableRotation();

  map.addControl(new AttributionControl({ compact: false }));
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

  return map;
}
