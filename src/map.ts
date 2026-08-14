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

/**
 * 国土地理院「電子国土基本図（オルソ画像）」タイル。API キー不要、出典表記が必須。
 *
 * 「全国最新写真（シームレス）」より鮮明で、畦道と圃場の境が読み取りやすい。
 * 同じタイル（z18）で 15.7KB に対して 59.5KB。どちらも z18 が上限で、それ以上は引き伸ばし。
 */
const PHOTO_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/ort/{z}/{x}/{y}.jpg';
const PHOTO_MAX_ZOOM = 18;
const PHOTO_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院 電子国土基本図（オルソ画像）</a>';

/** 初期表示位置（十日町）。GeoJSON と同じ順（経度, 緯度）で持つ。 */
const DEFAULT_CENTER: [lng: number, lat: number] = [138.70184, 37.0525];
const INITIAL_ZOOM = 17;

/** `?c=経度,緯度` で開始位置を変えられる。別の圃場を人に見せるときと、テストの固定に使う。 */
function initialCenter(): [lng: number, lat: number] {
  const value = new URLSearchParams(location.search).get('c');
  if (value === null) return DEFAULT_CENTER;

  const [lng, lat] = value.split(',').map(Number);
  const usable =
    lng !== undefined &&
    lat !== undefined &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 85;
  return usable ? [lng, lat] : DEFAULT_CENTER;
}

export function createMap(container: HTMLElement): MapLibreMap {
  const map = new MapLibreMap({
    container,
    center: initialCenter(),
    zoom: INITIAL_ZOOM,
    // タイルは 18 までなので、それ以上はオーバーズームで拡大表示する。
    maxZoom: 21,
    // 頂点編集で誤操作しないよう、回転・傾斜は無効にしておく。
    dragRotate: false,
    pitchWithRotate: false,
    // 自動検出が描画結果を canvas から読み出すので、バッファを破棄させない。
    canvasContextAttributes: { preserveDrawingBuffer: true },
    attributionControl: false,
    style: {
      version: 8,
      sources: {
        photo: {
          type: 'raster',
          tiles: [PHOTO_TILE_URL],
          tileSize: 256,
          maxzoom: PHOTO_MAX_ZOOM,
          attribution: PHOTO_ATTRIBUTION,
        },
      },
      layers: [
        {
          id: 'photo',
          type: 'raster',
          source: 'photo',
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
