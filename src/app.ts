import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  DetectionError,
  cameraKey,
  captureMap,
  detectOutline,
  loadOpenCV,
  waitForIdle,
} from './detect';
import { ItemEditor, isTyping, type EditKind, type EditState } from './editor';
import type { Vertex } from './geometry';
import { hintText, type AppMode, type Detection, type Tool } from './hints';
import { ItemLayer, ITEM_CASING_LAYER_ID, ITEM_FILL_LAYER_ID, ITEM_LINE_LAYER_ID } from './itemLayer';
import {
  ImportError,
  defaultColor,
  fromGeoJSON,
  loadStored,
  merge,
  minVertices,
  newItem,
  store,
  toGeoJSON,
  type Item,
  type ItemKind,
} from './items';
import { createMap, tileSources } from './map';
import { MeasureLabels } from './measureLabels';
import { applyOverlaySettings, OVERLAY_LAYER_IDS } from './overlays';
import { PinLayer } from './pins';
import { DetectPreview, PREVIEW_FILL_LAYER_ID, PREVIEW_LINE_LAYER_ID } from './preview';
import { loadSettings, storeSettings, type Settings } from './settings';
import { cacheStats, clearTiles, saveTiles, tileUrlsForView, SAVE_TILE_LIMIT } from './tileCache';
import { element } from './ui/dom';
import { Inspector } from './ui/inspector';
import { Sidebar } from './ui/sidebar';
import { SettingsSheet } from './ui/settingsSheet';

/** ツールと、編集器が扱う形の対応。 */
const TOOL_KIND: Record<Exclude<Tool, 'auto'>, EditKind> = {
  manual: 'polygon',
  measure: 'line',
  pin: 'point',
};

const KIND_OF_TOOL: Record<Exclude<Tool, 'auto'>, ItemKind> = {
  manual: 'paddy',
  measure: 'measure',
  pin: 'pin',
};

const TOOL_OF_KIND: Record<ItemKind, Tool> = {
  paddy: 'manual',
  measure: 'measure',
  pin: 'pin',
};

const EMPTY_EDIT: EditState = {
  kind: 'polygon',
  phase: 'drawing',
  vertexCount: 0,
  areaSquareMeters: null,
  totalMeters: null,
  canDeleteVertex: false,
  selfIntersecting: false,
};

/**
 * 画面全体の状態と配線。
 *
 * 表示（view）と編集（edit）の 2 つのモードがあり、編集のときだけ上のツールバーが出る。
 * 選んでいるものは右のインスペクタに出て、名前・色・アイコンをそこで変える。
 */
export function startApp(): void {
  const hint = element('hint');
  const modeInputs = [...document.querySelectorAll<HTMLInputElement>('#mode input')];
  const toolInputs = [...document.querySelectorAll<HTMLInputElement>('#tools input')];
  const toolbar = element('toolbar');
  const exportButton = element<HTMLButtonElement>('export');
  const importButton = element<HTMLButtonElement>('import');
  const importFile = element<HTMLInputElement>('import-file');
  const offlineStatus = element('offline-status');
  const offlineSaveButton = element<HTMLButtonElement>('offline-save');
  const offlineClearButton = element<HTMLButtonElement>('offline-clear');

  let settings: Settings = loadSettings();
  const map: MapLibreMap = createMap(element('map'), settings);
  // ブラウザから回す確認用の窓口。地図の状態（レイヤーの可視や濃さ）は DOM に出ないので、
  // ここから読めるようにしておく。読むだけで、アプリはこれを使わない。
  (window as unknown as { __tanboMap: MapLibreMap }).__tanboMap = map;

  let ready = false;
  let mode: AppMode = 'view';
  let tool: Tool = 'manual';
  let items: Item[] = [];
  let selectedId: string | null = null;
  /** 編集器に載っているもの。まだ確定していない描きかけは null。 */
  let editingId: string | null = null;
  let edit: EditState = EMPTY_EDIT;
  let detection: Detection = { status: 'idle' };
  let notice: string | null = null;
  /** 検出ごとの通し番号。割り込まれた古い検出の結果を捨てるために使う。 */
  let detectionToken = 0;
  let storeTimer: ReturnType<typeof setTimeout> | undefined;
  let listDirty = true;
  /**
   * 組み立てが済むまで描画しない。編集器は作られた時点で 1 回状態を知らせてくるので、
   * その時点ではまだ一覧もインスペクタも存在しない。
   */
  let wired = false;

  // レイヤーもソースも、スタイルができるまでは足せない。地図まわりの組み立ては
  // すべてここから始める。
  map.on('style.load', () => {
    wire();
  });

  function wire(): void {
    const editor = new ItemEditor(map, (state) => {
      const wasDrawing = edit.phase === 'drawing';
      edit = state;
      if (state.phase === 'editing') syncEditingItem(wasDrawing);
      render();
    });
    const itemLayer = new ItemLayer(map, 'tanbo-edit-fill');
    const pinLayer = new PinLayer(map, (id) => selectItem(id));
    const labels = new MeasureLabels(map);
    const preview = new DetectPreview(map, (masked) => setDetectionMasked(masked), 'tanbo-edit-fill');
    const sidebar = new Sidebar({
      onSelect: (id) => selectItem(id),
      onToggleVisible: (id) => toggleVisible(id),
      onDelete: (id) => removeItem(id),
    });
    const inspector = new Inspector({
      onRename: (id, name) => updateItem(id, (item) => ({ ...item, name })),
      onRecolor: (id, color) => {
        updateItem(id, (item) => ({ ...item, color }));
        if (id === editingId) editor.setColor(color);
      },
      onIcon: (id, icon) => updateItem(id, (item) => ({ ...item, icon })),
      onEdit: (id) => {
        setMode('edit');
        selectItem(id);
      },
      onDelete: (id) => removeItem(id),
      onClose: () => {
        selectedId = null;
        listDirty = true;
        render();
      },
    });
    const settingsSheet = new SettingsSheet(settings, {
      onOverlayChange: (next) => {
        settings = next;
        applyOverlaySettings(map, settings);
        storeSettings(settings);
      },
      onSaveTiles: () => void saveVisibleArea(),
      onClearTiles: () => void clearSavedTiles(),
    });

    // MARK: - 保存

    /** 保存に失敗したら黙って続けない。保存できていないのに保存済みだと思わせるのが一番まずい。 */
    function persist(): void {
      clearTimeout(storeTimer);
      storeTimer = undefined;
      if (!store(items)) notice = '保存できませんでした（ブラウザの保存領域を確認してください）';
    }

    /** 書き出しは、ドラッグが落ち着いてからまとめて行う。 */
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

    // MARK: - item の出し入れ

    function selectedItem(): Item | null {
      return items.find((item) => item.id === selectedId) ?? null;
    }

    function updateItem(id: string, change: (item: Item) => Item): void {
      items = items.map((item) => (item.id === id ? change(item) : item));
      listDirty = true;
      scheduleStore();
      render();
    }

    /** 編集器の中身を、対応する item に反映する。確定した瞬間に 1 つ作る。 */
    function syncEditingItem(justClosed: boolean): void {
      const vertices = editor.vertices;
      if (vertices.length < minVertices(kindOfTool())) return;

      if (editingId === null) {
        if (!justClosed) return;
        const item = newItem(kindOfTool(), vertices, items);
        items = [...items, item];
        editingId = item.id;
        selectedId = item.id;
        listDirty = true;
        editor.setColor(item.color);
      } else {
        items = items.map((item) => (item.id === editingId ? { ...item, vertices } : item));
      }
      scheduleStore();
    }

    function kindOfTool(): ItemKind {
      return KIND_OF_TOOL[tool === 'auto' ? 'manual' : tool];
    }

    function selectItem(id: string): void {
      const item = items.find((candidate) => candidate.id === id);
      if (item === undefined) return;

      detectionToken += 1;
      detection = { status: 'idle' };
      notice = null;
      selectedId = id;

      if (mode === 'edit') {
        loadIntoEditor(item);
      } else {
        commitEditing();
        fitTo(item);
      }
      listDirty = true;
      render();
    }

    function loadIntoEditor(item: Item): void {
      setTool(TOOL_OF_KIND[item.kind], false);
      editingId = item.id;
      editor.load(TOOL_KIND[TOOL_OF_KIND[item.kind] as Exclude<Tool, 'auto'>], item.vertices, item.color);
      if (item.kind === 'pin') pinLayer.setDraggable(item.id, (position) => movePin(item.id, position));
    }

    function movePin(id: string, position: Vertex): void {
      items = items.map((item) => (item.id === id ? { ...item, vertices: [position] } : item));
      scheduleStore();
      render();
    }

    function fitTo(item: Item): void {
      const lngs = item.vertices.map(([lng]) => lng);
      const lats = item.vertices.map(([, lat]) => lat);
      if (lngs.length === 0) return;
      if (item.kind === 'pin') {
        map.easeTo({ center: item.vertices[0]!, duration: 400 });
        return;
      }
      map.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: 80, duration: 400 }
      );
    }

    function toggleVisible(id: string): void {
      updateItem(id, (item) => ({ ...item, visible: !item.visible }));
    }

    function removeItem(id: string): void {
      const item = items.find((candidate) => candidate.id === id);
      if (item === undefined || !confirm(`${item.name} を削除しますか？`)) return;

      detectionToken += 1;
      items = items.filter((candidate) => candidate.id !== id);
      if (editingId === id) {
        editingId = null;
        editor.begin(TOOL_KIND[tool === 'auto' ? 'manual' : tool], defaultColor(kindOfTool()));
      }
      if (selectedId === id) selectedId = null;
      notice = null;
      persist();
      listDirty = true;
      render();
    }

    /** 編集をやめて、描いていたものを手放す。 */
    function commitEditing(): void {
      if (editingId === null && edit.vertexCount === 0) return;
      editingId = null;
      pinLayer.setDraggable(null, () => undefined);
      editor.begin(TOOL_KIND[tool === 'auto' ? 'manual' : tool], defaultColor(kindOfTool()));
      edit = EMPTY_EDIT;
      labels.clear();
    }

    // MARK: - モードとツール

    function setMode(next: AppMode): void {
      mode = next;
      for (const input of modeInputs) input.checked = input.value === next;
      toolbar.hidden = next !== 'edit';

      if (next === 'view') {
        commitEditing();
        editor.setEnabled(false);
        preview.setEnabled(false);
      } else {
        editor.setEnabled(tool !== 'auto');
        const item = selectedItem();
        if (item !== null) loadIntoEditor(item);
      }
      render();
    }

    function setTool(next: Tool, restart = true): void {
      // 同じ道具を押し直したときも、いま描いているものは手放す（それが「次を描く」の合図）。
      if (restart) commitEditing();
      tool = next;
      for (const input of toolInputs) input.checked = input.value === next;

      // 自動検出のあいだはクリックを検出側に譲る。
      editor.setEnabled(mode === 'edit' && next !== 'auto');
      preview.setEnabled(mode === 'edit' && next === 'auto');
      if (next === 'auto') void loadOpenCV().catch(() => undefined);
      if (restart && next !== 'auto') {
        editor.begin(TOOL_KIND[next], defaultColor(KIND_OF_TOOL[next]));
      }
      map.getCanvas().style.cursor = mode === 'edit' && next === 'auto' ? 'crosshair' : '';
      render();
    }

    for (const input of modeInputs) {
      input.addEventListener('change', () => {
        if (input.checked) setMode(input.value as AppMode);
      });
    }
    for (const input of toolInputs) {
      input.addEventListener('change', () => {
        if (input.checked) setTool(input.value as Tool);
      });
      // 選んでいる道具をもう一度押したら、いま描いているものを確定して次を始める。
      // change は飛んでこないので、click で受ける。
      input.addEventListener('click', () => {
        if (input.value === tool) setTool(input.value as Tool);
      });
    }
    // MARK: - 描画

    function render(): void {
      if (!wired) return;
      const busy = detection.status === 'running';
      const selected = selectedItem();

      hint.textContent = hintText({
        ready,
        mode,
        tool,
        edit,
        detection,
        notice,
        itemCount: items.length,
        hasSelection: selected !== null,
      });
      hint.classList.toggle(
        'warning',
        edit.selfIntersecting || detection.status === 'failed' || notice !== null
      );

      for (const input of modeInputs) input.disabled = !ready || busy;
      for (const input of toolInputs) input.disabled = !ready || busy;
      exportButton.disabled = !ready || busy || items.length === 0;
      importButton.disabled = !ready || busy;

      itemLayer.setItems(items, selectedId, editingId);
      pinLayer.setPins(
        items.filter((item) => item.kind === 'pin' && item.visible),
        selectedId
      );

      // 計測のラベルは、いじっているものと選んでいるものだけ。全部出すと写真が埋まる。
      const liveLine = editingId !== null && edit.kind === 'line' ? editor.vertices : null;
      const selectedLine =
        selected?.kind === 'measure' && selected.id !== editingId ? selected.vertices : null;
      labels.setLine(liveLine ?? selectedLine ?? []);

      if (listDirty) {
        listDirty = false;
        sidebar.render(items, selectedId, editingId);
      } else {
        sidebar.refreshLive(items);
      }
      // 確定前でも面積と長さは見たい。名前や色はまだ無いので、数値だけ出す。
      if (selected === null && edit.vertexCount > 0) {
        inspector.renderDraft(edit.areaSquareMeters, edit.totalMeters);
      } else {
        inspector.render(selected, selected !== null && selected.id === editingId);
      }
    }

    // MARK: - 地図のクリック

    map.on('mousemove', (event) => {
      if (mode === 'edit' && tool === 'auto') preview.moved(event.point);
    });

    map.on('click', (event) => {
      if (mode === 'edit') {
        if (tool !== 'auto' || detection.status === 'running') return;
        // 見えている輪郭があれば、それをそのまま確定する。
        // 別のものが出てくると、何を確定したのか分からなくなる。
        const previewed = preview.commit(event.point);
        if (previewed !== null) {
          acceptOutline(previewed);
          render();
          return;
        }
        void detectAt(event.point);
        return;
      }

      // 表示モードでは、地図に出ているものを選ぶ。
      const features = map.queryRenderedFeatures(event.point, {
        layers: [ITEM_FILL_LAYER_ID, ITEM_CASING_LAYER_ID, ITEM_LINE_LAYER_ID],
      });
      const id = features[0]?.properties?.['id'];
      if (typeof id === 'string') {
        selectItem(id);
        return;
      }
      if (selectedId !== null) {
        selectedId = null;
        listDirty = true;
        render();
      }
    });

    // MARK: - 自動検出

    async function detectAt(point: Parameters<typeof detectOutline>[2]): Promise<void> {
      const token = (detectionToken += 1);
      // クリックした瞬間のカメラ。タイル待ちのあいだに地図を動かされると、
      // 指した場所と写真がずれる。
      const clickedCamera = cameraKey(map);
      detection = { status: 'running' };
      render();

      try {
        // 描いたものや重ねた地図が写り込むと、その線がフラッドフィルの壁になる。
        setDetectionMasked(true);
        let capture;
        try {
          await waitForIdle(map);
          if (cameraKey(map) !== clickedCamera) {
            throw new DetectionError('地図が動きました。もう一度クリックしてください');
          }
          capture = captureMap(map);
        } finally {
          setDetectionMasked(false);
        }

        const vertices = await detectOutline(map, capture, point);
        if (token !== detectionToken) return;

        acceptOutline(vertices);
        detection = { status: 'idle' };
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
    }

    /** 検出した輪郭を下書きとして受け取り、そのまま頂点を直せる状態にする。 */
    function acceptOutline(vertices: Vertex[]): void {
      commitEditing();
      preview.clear();
      setTool('manual', false);
      editor.load('polygon', vertices, defaultColor('paddy'));
      edit = { ...edit, phase: 'editing' };
      syncEditingItem(true);
    }

    /** 自動検出が写真だけを読めるよう、描いたものと重ねた地図を隠す。 */
    function setDetectionMasked(masked: boolean): void {
      itemLayer.setVisible(!masked);
      editor.setLayersVisible(!masked);
      for (const id of [PREVIEW_FILL_LAYER_ID, PREVIEW_LINE_LAYER_ID]) {
        if (map.getLayer(id) !== undefined) {
          map.setLayoutProperty(id, 'visibility', masked ? 'none' : 'visible');
        }
      }
      for (const id of OVERLAY_LAYER_IDS) {
        if (map.getLayer(id) === undefined) continue;
        // 出していない地図は元から none なので、設定を見て戻す。
        const on = settings.overlays[id.replace('overlay-', '') as keyof Settings['overlays']].on;
        map.setLayoutProperty(id, 'visibility', masked ? 'none' : on ? 'visible' : 'none');
      }
    }

    // MARK: - 書き出しと読み込み

    exportButton.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(toGeoJSON(items), null, 2)], {
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
        // 取り込んだものは別のものとして足す。既存を消したいときは一覧から削除する。
        items = merge(items, imported.items);
        commitEditing();
        selectedId = null;
        notice = imported.skipped === 0 ? null : `${imported.skipped} 件は取り込めませんでした`;
        persist();
      } catch (error) {
        notice = error instanceof ImportError ? error.message : '読み込みに失敗しました';
        if (!(error instanceof ImportError)) console.error(error);
      }
      listDirty = true;
      render();
    });

    // MARK: - オフライン用のタイル

    let tileSaving: AbortController | null = null;
    /** 直前の操作の結果。地図を動かすたびに消えると、何が起きたか読めなくなる。 */
    let offlineMessage: string | null = null;

    function formatBytes(bytes: number): string {
      const megabytes = bytes / 1024 / 1024;
      return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
    }

    async function refreshOfflineStatus(): Promise<void> {
      const { count, bytes } = await cacheStats();
      const stored =
        count === 0 ? 'まだ保存していません' : `${count.toLocaleString()} 枚・${formatBytes(bytes)}`;
      offlineStatus.textContent = offlineMessage === null ? stored : `${offlineMessage}（${stored}）`;
      // 保存中も押せる（そのときは「中止」として働く）。
      offlineSaveButton.disabled = false;
      offlineClearButton.disabled = count === 0 || tileSaving !== null;
    }

    /**
     * 保存の結果。「保存しました」とだけ出して現地で写真が出ない、が一番まずいので、
     * 取れなかった分もためられなかった分もそのまま出す。
     */
    function saveMessage(stopped: boolean, failed: number, notStored: number): string {
      if (stopped) return '中止しました';
      // 保存領域が一杯か、ブラウザが IndexedDB を使わせない。取れていても現地では出ない。
      if (notStored > 0) return `${notStored.toLocaleString()} 枚を保存できませんでした`;
      // 市域外では十日町市のタイルが 404 になる。地理院タイルがあるので地図自体は出る。
      if (failed > 0) return `保存しました。${failed.toLocaleString()} 枚は取れませんでした`;
      return '保存しました';
    }

    async function saveVisibleArea(): Promise<void> {
      if (tileSaving !== null) {
        tileSaving.abort();
        return;
      }

      const bounds = map.getBounds();
      const urls = tileUrlsForView(
        tileSources(settings),
        [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        map.getZoom()
      );

      if (urls.length > SAVE_TILE_LIMIT) {
        offlineStatus.textContent = `範囲が広すぎます（${urls.length.toLocaleString()} 枚）。ズームを上げるか、重ねる地図を減らしてください`;
        return;
      }
      if (!confirm(`表示中の範囲の写真 ${urls.length.toLocaleString()} 枚を保存しますか？`)) return;

      tileSaving = new AbortController();
      offlineSaveButton.textContent = '中止';
      offlineClearButton.disabled = true;
      const { failed, notStored } = await saveTiles(
        urls,
        (done, total) => {
          offlineStatus.textContent = `保存中… ${done.toLocaleString()} / ${total.toLocaleString()}`;
        },
        tileSaving.signal
      );

      const stopped = tileSaving.signal.aborted;
      tileSaving = null;
      offlineSaveButton.textContent = 'この範囲を保存';
      offlineMessage = saveMessage(stopped, failed, notStored);
      await refreshOfflineStatus();
    }

    async function clearSavedTiles(): Promise<void> {
      if (!confirm('保存した写真を消しますか？')) return;
      const cleared = await clearTiles();
      // 消したあとは、直前の「保存しました」を引きずらない。
      offlineMessage = cleared ? null : '消せませんでした';
      await refreshOfflineStatus();
    }

    // 見ているだけでもタイルはたまる。地図が落ち着くたびに、たまった量を出し直す。
    map.on('idle', () => {
      if (tileSaving === null) void refreshOfflineStatus();
    });

    // MARK: - 起動

    window.addEventListener('keydown', (event) => {
      if (isTyping(event.target)) return;
      if (event.key === 'Escape' && mode === 'edit' && edit.vertexCount === 0) setMode('view');
    });


    applyOverlaySettings(map, settings);
    items = loadStored();
    ready = true;
    listDirty = true;
    wired = true;
    setMode('view');
    void refreshOfflineStatus();
    void settingsSheet;
  }
}
