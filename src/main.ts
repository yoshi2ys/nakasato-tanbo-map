import './style.css';
import { PolygonDrawer, type DrawState } from './draw';
import {
  DetectionError,
  cameraKey,
  captureMap,
  detectOutline,
  loadOpenCV,
  waitForIdle,
} from './detect';
import { createMap } from './map';
import { formatArea } from './units';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} が見つかりません`);
  return found as T;
}

const hint = element('hint');
const areaList = element('area');
const areaSquareMetersValue = element('area-square-meters');
const areaTanValue = element('area-tan');
const areaSeValue = element('area-se');
const resetButton = element<HTMLButtonElement>('reset');
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('#mode input')];

/** 自動検出の進行状況。ヒント欄を占有するので、描画の状態より優先して出す。 */
type Detection = { status: 'idle' } | { status: 'running' } | { status: 'failed'; message: string };

let drawState: DrawState = {
  mode: 'drawing',
  vertexCount: 0,
  areaSquareMeters: null,
  canDeleteVertex: false,
  selfIntersecting: false,
};
let detection: Detection = { status: 'idle' };
let autoMode = false;
/** 地図のスタイルが揃うまでは、パネルの操作を受け付けない。 */
let ready = false;
/** 検出ごとの通し番号。割り込まれた古い検出の結果を捨てるために使う。 */
let detectionToken = 0;

function hintText(): string {
  if (!ready) return '読み込み中…';
  if (detection.status === 'running') return '検出中…';
  if (detection.status === 'failed') return detection.message;
  if (drawState.selfIntersecting) return '輪郭が交差しています。この面積は当てになりません';

  if (autoMode) return '田んぼの中をクリックすると輪郭を推定します';
  if (drawState.mode === 'editing') {
    return drawState.canDeleteVertex
      ? '頂点をドラッグで移動、中点をクリックで追加。削除は右クリック、または選択して Delete'
      : '頂点をドラッグで移動、中点をクリックで追加（これ以上は減らせません）';
  }
  if (drawState.vertexCount >= 3) return '開始点をクリック / ダブルクリック / Enter で閉じる';
  if (drawState.vertexCount >= 1) return 'クリックで頂点を追加（Esc で最初からやり直す）';
  return 'クリックで頂点を追加';
}

function render(): void {
  const { areaSquareMeters, selfIntersecting, vertexCount } = drawState;
  const busy = detection.status === 'running';

  areaList.hidden = areaSquareMeters === null;
  areaList.classList.toggle('unreliable', selfIntersecting);
  if (areaSquareMeters !== null) {
    const formatted = formatArea(areaSquareMeters);
    areaSquareMetersValue.textContent = formatted.squareMeters;
    areaTanValue.textContent = formatted.tan;
    areaSeValue.textContent = formatted.se;
  }

  hint.textContent = hintText();
  hint.classList.toggle('warning', selfIntersecting || detection.status === 'failed');
  resetButton.disabled = !ready || busy || vertexCount === 0;
  // 検出中にモードを変えられると、隠したままのレイヤーの上に手動で描けてしまう。
  for (const input of modeInputs) input.disabled = !ready || busy;
}

const map = createMap(element('map'));

map.on('load', () => {
  const drawer = new PolygonDrawer(map, (state) => {
    drawState = state;
    render();
  });

  function setAutoMode(enabled: boolean): void {
    autoMode = enabled;
    for (const input of modeInputs) input.checked = (input.value === 'auto') === enabled;
    drawer.setEnabled(!enabled);
    map.getCanvas().style.cursor = enabled ? 'crosshair' : '';
  }

  resetButton.addEventListener('click', () => {
    drawer.reset();
    detection = { status: 'idle' };
    render();
    // フォーカスが残ると、閉合したいときの Enter がボタンのクリックに化ける。
    resetButton.blur();
  });

  for (const input of modeInputs) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      setAutoMode(input.value === 'auto');
      // 13MB の読み込みは、クリックを待たずに始めておく。
      if (autoMode) void loadOpenCV().catch(() => undefined);
      detection = { status: 'idle' };
      render();
    });
  }

  map.on('click', async (event) => {
    if (!autoMode || detection.status === 'running') return;

    const token = (detectionToken += 1);
    // クリックした瞬間のカメラ。タイル待ちのあいだに地図を動かされると、
    // event.point の指す場所と写真がずれる。
    const clickedCamera = cameraKey(map);
    detection = { status: 'running' };
    render();

    try {
      // 描いたものが写真に重なっていると検出の邪魔になるので、撮るあいだだけ隠す。
      // 撮影はクリック直後に済ませる。OpenCV の読み込みを待つあいだに地図を動かされると、
      // シードの画面座標と写真がずれてしまう。
      drawer.setLayersVisible(false);
      let capture;
      try {
        await waitForIdle(map);
        if (cameraKey(map) !== clickedCamera) {
          throw new DetectionError('地図が動きました。もう一度クリックしてください');
        }
        capture = captureMap(map);
      } finally {
        drawer.setLayersVisible(true);
      }

      const vertices = await detectOutline(map, capture, event.point);
      if (token !== detectionToken) return;

      drawer.load(vertices);
      detection = { status: 'idle' };
      // 検出結果は下書き。そのまま頂点を直せるよう、手動（編集）に戻す。
      setAutoMode(false);
    } catch (error) {
      if (token !== detectionToken) return;
      detection = {
        status: 'failed',
        message:
          error instanceof DetectionError ? error.message : '検出に失敗しました（詳細は console）',
      };
      if (!(error instanceof DetectionError)) console.error(error);
    } finally {
      if (token === detectionToken) render();
    }
  });

  ready = true;
  render();
});

render();
