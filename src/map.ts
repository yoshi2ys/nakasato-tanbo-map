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
 * 全国の下地。国土地理院「電子国土基本図（オルソ画像）」タイル。API キー不要、出典表記が必須。
 *
 * 「全国最新写真（シームレス）」より鮮明で、畦道と圃場の境が読み取りやすい。
 * 同じタイル（z18）で 15.7KB に対して 59.5KB。どちらも z18 が上限で、それ以上は引き伸ばし。
 */
const GSI_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/ort/{z}/{x}/{y}.jpg';
const GSI_MAX_ZOOM = 18;
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院 電子国土基本図（オルソ画像）</a>';

/**
 * 十日町市公開地理情報システムの航空写真（2022 年撮影）。市域だけを覆う。
 *
 * z20 まであり、地理院タイル（z18 上限）の 4 倍の解像度。同じ z18 タイルで 150KB 対 59.5KB。
 * y 軸が反転した TMS 方式なので `scheme` の指定が要る。市外は 404 になり、下の地理院タイルが出る。
 *
 * 著作権は十日町市にあり、私的使用の範囲内でのみ利用できる（営利・商業利用は不可）。
 * 出典: http://map.city.tokamachi.lg.jp/ の利用規約
 */
const TOKAMACHI_TILE_URL =
  'https://geogeo.blob.core.windows.net/tiles/15210/2022/ortho/{z}/{x}/{y}.png';
const TOKAMACHI_MAX_ZOOM = 20;
/**
 * 配信されている範囲 [西, 南, 東, 北]。z12 のタイルを総当たりして実測した外接矩形。
 * これを渡さないと市外でもタイルを取りに行き、404 が大量に出るうえ、
 * ソースがいつまでも読み込み中のままになって地図の load が発火しない。
 */
const TOKAMACHI_BOUNDS: [number, number, number, number] = [138.5156, 36.8093, 138.9551, 37.3003];
const TOKAMACHI_ATTRIBUTION =
  '<a href="http://map.city.tokamachi.lg.jp/" target="_blank" rel="noreferrer">十日町市公開地理情報システム 航空写真</a>';

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
    // 十日町市の写真は z20 まであるので、地図側は 19 まで等倍で見られる。
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
        gsi: {
          type: 'raster',
          tiles: [GSI_TILE_URL],
          tileSize: 256,
          maxzoom: GSI_MAX_ZOOM,
          attribution: GSI_ATTRIBUTION,
        },
        tokamachi: {
          type: 'raster',
          tiles: [TOKAMACHI_TILE_URL],
          tileSize: 256,
          maxzoom: TOKAMACHI_MAX_ZOOM,
          bounds: TOKAMACHI_BOUNDS,
          scheme: 'tms',
          attribution: TOKAMACHI_ATTRIBUTION,
        },
      },
      layers: [
        {
          id: 'gsi',
          type: 'raster',
          source: 'gsi',
          paint: {
            // タイルは z18 が上限なので、それ以上のズームでは必ず引き伸ばしになる。
            // 既定の linear 補間はそこを平滑化してしまい、畦道の輪郭がぼやける。
            // nearest なら画素の境目は残るが、圃場の境界は読み取りやすい。
            'raster-resampling': 'nearest',
          },
        },
        // 市域では地理院タイルより鮮明なので上に重ねる。市外は 404 で下が透ける。
        {
          id: 'tokamachi',
          type: 'raster',
          source: 'tokamachi',
          paint: { 'raster-resampling': 'nearest' },
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
