import './style.css';
import { FILL_LAYER_ID, PolygonDrawer, type DrawState } from './draw';
import {
  DetectionError,
  cameraKey,
  captureMap,
  detectOutline,
  loadOpenCV,
  waitForIdle,
} from './detect';
import { createMap } from './map';
import {
  ImportError,
  fromGeoJSON,
  isPaddyReliable,
  loadStored,
  merge,
  newPaddy,
  paddyArea,
  store,
  toGeoJSON,
  type Paddy,
} from './paddies';
import { SavedPaddyLayer } from './paddyLayer';
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
const paddyList = element<HTMLUListElement>('paddies');
const libraryEmpty = element('library-empty');
const exportButton = element<HTMLButtonElement>('export');
const importButton = element<HTMLButtonElement>('import');
const importFile = element<HTMLInputElement>('import-file');

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
/** 取り込みや保存の結果。検出の進行とは別の話なので、状態を分けて持つ。 */
let notice: string | null = null;
let autoMode = false;
/** 地図のスタイルが揃うまでは、パネルの操作を受け付けない。 */
let ready = false;
/** 検出ごとの通し番号。割り込まれた古い検出の結果を捨てるために使う。 */
let detectionToken = 0;

let paddies: Paddy[] = [];
/** いま編集している田んぼ。まだ閉合していないあいだは null。 */
let activeId: string | null = null;
let storeTimer: number | undefined;
/** 一覧の再構築はドラッグ中に毎フレームやる必要がない。 */
let listDirty = true;
/** 編集中の田んぼの面積を出しているセル。ドラッグ中はここだけ書き換える。 */
let activeAreaElement: HTMLElement | null = null;

function hintText(): string {
  if (!ready) return '読み込み中…';
  if (detection.status === 'running') return '検出中…';
  if (detection.status === 'failed') return detection.message;
  if (notice !== null) return notice;
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

/** 保存に失敗したら黙って続けない。保存できていないのに保存済みだと思わせるのが一番まずい。 */
function persist(): void {
  clearTimeout(storeTimer);
  storeTimer = undefined;
  if (!store(paddies)) notice = '保存できませんでした（ブラウザの保存領域を確認してください）';
}

/** localStorage への書き出しは、ドラッグが落ち着いてからまとめて行う。 */
function scheduleStore(): void {
  clearTimeout(storeTimer);
  storeTimer = setTimeout(persist, 400);
}

// 書き出し待ちのまま閉じられると、直前の編集が消える。
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && storeTimer !== undefined) persist();
});
window.addEventListener('pagehide', () => {
  if (storeTimer !== undefined) persist();
});

const map = createMap(element('map'));

// タイルの読み込みではなくスタイルの用意ができた時点で始める。
// 写真タイルが落ちてもアプリが起動しないという状態を作らないため。
map.on('style.load', () => {
  const drawer = new PolygonDrawer(map, (state) => {
    const closed = state.mode === 'editing';
    const wasClosed = drawState.mode === 'editing';
    drawState = state;

    if (closed) syncActivePaddy();
    // 一覧に出る名前と面積が変わるのは、閉合したときと頂点を動かしたとき。
    if (closed !== wasClosed) listDirty = true;
    render();
  });
  const savedLayer = new SavedPaddyLayer(map, FILL_LAYER_ID);

  /** 編集中の輪郭を、保存済みの 1 枚として反映する。閉合しているあいだだけ呼ぶ。 */
  function syncActivePaddy(): void {
    const vertices = drawer.vertices;
    if (vertices.length < 3) return;

    const existing = paddies.find((paddy) => paddy.id === activeId);
    if (existing === undefined) {
      const paddy = newPaddy(vertices, paddies);
      paddies = [...paddies, paddy];
      activeId = paddy.id;
      listDirty = true;
      // 保存済みの集合が変わるのは、新しい 1 枚が加わったときだけ。
      // ドラッグ中の毎フレームここを呼ぶと、全田んぼを作り直すことになる。
      refreshSavedLayer();
    } else {
      existing.vertices = vertices;
    }
    scheduleStore();
  }

  /** 編集中の 1 枚を除いた保存済みを地図に反映する。 */
  function refreshSavedLayer(): void {
    savedLayer.setPaddies(paddies.filter((paddy) => paddy.id !== activeId));
  }

  function selectPaddy(id: string): void {
    const paddy = paddies.find((item) => item.id === id);
    if (paddy === undefined) return;

    // 走行中の検出があれば、その結果でこの選択を上書きさせない。
    detectionToken += 1;
    activeId = id;
    detection = { status: 'idle' };
    notice = null;
    setAutoMode(false);
    drawer.load(paddy.vertices);
    refreshSavedLayer();

    const lngs = paddy.vertices.map(([lng]) => lng);
    const lats = paddy.vertices.map(([, lat]) => lat);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 80, duration: 400 }
    );
    listDirty = true;
    render();
  }

  function remove(id: string): void {
    const paddy = paddies.find((item) => item.id === id);
    // 一覧の ✕ は選択ボタンの真横にあり、消すと元に戻せない。
    if (paddy === undefined || !confirm(`${paddy.name} を削除しますか？`)) return;

    detectionToken += 1;
    paddies = paddies.filter((item) => item.id !== id);
    if (activeId === id) {
      activeId = null;
      drawer.reset();
    }
    notice = null;
    persist();
    refreshSavedLayer();
    listDirty = true;
    render();
  }

  /** 交差した輪郭は面積を出さない。もっともらしい数字を並べるのが一番まずい。 */
  function areaLabel(paddy: Paddy): string {
    if (!isPaddyReliable(paddy)) return '輪郭が交差';
    return `${formatArea(paddyArea(paddy)).squareMeters} ㎡`;
  }

  function renderList(): void {
    activeAreaElement = null;
    paddyList.replaceChildren(
      ...paddies.map((paddy) => {
        const row = document.createElement('li');
        row.classList.toggle('active', paddy.id === activeId);

        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.className = 'paddy-select';
        selectButton.addEventListener('click', () => selectPaddy(paddy.id));

        const name = document.createElement('span');
        name.textContent = paddy.name;
        const size = document.createElement('span');
        size.className = 'paddy-area';
        size.textContent = areaLabel(paddy);
        if (paddy.id === activeId) activeAreaElement = size;
        selectButton.append(name, size);

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'paddy-delete';
        deleteButton.textContent = '✕';
        deleteButton.title = `${paddy.name} を削除`;
        deleteButton.addEventListener('click', () => remove(paddy.id));

        row.append(selectButton, deleteButton);
        return row;
      })
    );

    libraryEmpty.hidden = paddies.length > 0;
    exportButton.disabled = !ready || detection.status === 'running' || paddies.length === 0;
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
    hint.classList.toggle(
      'warning',
      selfIntersecting || detection.status === 'failed' || notice !== null
    );
    resetButton.disabled = !ready || busy || vertexCount === 0;
    // 検出中にモードを変えられると、隠したままのレイヤーの上に手動で描けてしまう。
    for (const input of modeInputs) input.disabled = !ready || busy;
    importButton.disabled = !ready || busy;
    paddyList.classList.toggle('locked', !ready || busy);

    if (listDirty) {
      listDirty = false;
      renderList();
    } else if (activeAreaElement !== null) {
      // 頂点を動かしているあいだ、一覧を作り直さずにその行の面積だけ書き換える。
      const active = paddies.find((paddy) => paddy.id === activeId);
      if (active !== undefined) activeAreaElement.textContent = areaLabel(active);
    }
  }

  function setAutoMode(enabled: boolean): void {
    autoMode = enabled;
    for (const input of modeInputs) input.checked = (input.value === 'auto') === enabled;
    drawer.setEnabled(!enabled);
    map.getCanvas().style.cursor = enabled ? 'crosshair' : '';
  }

  resetButton.addEventListener('click', () => {
    // 保存済みの 1 枚は残したまま、次の田んぼを描き始める。
    detectionToken += 1;
    activeId = null;
    drawer.reset();
    refreshSavedLayer();
    detection = { status: 'idle' };
    notice = null;
    listDirty = true;
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
      notice = null;
      render();
    });
  }

  exportButton.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(toGeoJSON(paddies), null, 2)], {
      type: 'application/geo+json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'tanbo.geojson';
    link.click();
    // click と同期で revoke すると、ブラウザによってはダウンロードが空振りする。
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  importButton.addEventListener('click', () => importFile.click());

  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    // 同じファイルを選び直しても change が飛ぶようにしておく。
    importFile.value = '';
    if (file === undefined) return;

    detectionToken += 1;
    detection = { status: 'idle' };
    try {
      const imported = fromGeoJSON(await file.text());
      // 取り込んだものは別の田んぼとして足す。既存を消したいときは一覧から削除する。
      paddies = merge(paddies, imported.paddies);
      activeId = null;
      drawer.reset();
      refreshSavedLayer();
      notice = imported.skipped === 0 ? null : `${imported.skipped} 件は取り込めませんでした`;
      persist();
    } catch (error) {
      notice = error instanceof ImportError ? error.message : '読み込みに失敗しました';
      if (!(error instanceof ImportError)) console.error(error);
    }
    listDirty = true;
    render();
  });

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
      // 保存済みの輪郭も写り込むと、その色と線がフラッドフィルの壁になる。
      drawer.setLayersVisible(false);
      savedLayer.setVisible(false);
      let capture;
      try {
        await waitForIdle(map);
        if (cameraKey(map) !== clickedCamera) {
          throw new DetectionError('地図が動きました。もう一度クリックしてください');
        }
        capture = captureMap(map);
      } finally {
        drawer.setLayersVisible(true);
        savedLayer.setVisible(true);
      }

      const vertices = await detectOutline(map, capture, event.point);
      if (token !== detectionToken) return;

      // 検出は常に新しい 1 枚として扱う。編集中のものを黙って置き換えない。
      activeId = null;
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

  paddies = loadStored();
  refreshSavedLayer();
  ready = true;
  listDirty = true;
  render();
});
