import { LngLatBounds, type Map as MapLibreMap, type Point } from 'maplibre-gl';
import { DetectionError, captureMasked, cameraKey, detectOutline, loadOpenCV } from './detect';
import { EDIT_FILL_LAYER_ID, ItemEditor, type EditKind, type EditState } from './editor';
import type { Vertex } from './geometry';
import { hintText, type AppMode, type Detection, type Tool } from './hints';
import {
  ItemLayer,
  ITEM_CASING_LAYER_ID,
  ITEM_FILL_LAYER_ID,
  ITEM_LINE_LAYER_ID,
  ITEM_MEASURE_LAYER_ID,
} from './itemLayer';
import {
  ImportError,
  defaultColor,
  groupNames,
  NO_GROUP,
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
import { createMap, setRotationEnabled, tileSources } from './map';
import { MeasureLabels } from './measureLabels';
import { applyOverlaySettings, OVERLAY_LAYER_IDS } from './overlays';
import { PinLayer } from './pins';
import { DetectPreview, PREVIEW_FILL_LAYER_ID, PREVIEW_LINE_LAYER_ID } from './preview';
import { loadSettings, storeSettings, TEXT_SCALE_FACTOR, type Settings } from './settings';
import { cacheStats, clearTiles, saveTiles, tileUrlsForView, SAVE_TILE_LIMIT } from './tileCache';
import { iconSvg } from './icons';
import { captureImage, imageFileName, type CropRect, type ImageFormat } from './snapshot';
import { CropBar } from './ui/cropBar';
import { element, isTyping, setIcon } from './ui/dom';
import { DetailSheet } from './ui/detailSheet';
import { Panel } from './ui/panel';
import { Sidebar } from './ui/sidebar';
import { SettingsSheet } from './ui/settingsSheet';

/**
 * 道具と、それが作るものと、その形。自動検出は田んぼを作るので手動範囲と同じ組。
 * 3 つの表に分けると、種類から形を引くのに 2 回引き直すことになる。
 */
const TOOLS: Record<Tool, { kind: ItemKind; shape: EditKind }> = {
  manual: { kind: 'paddy', shape: 'polygon' },
  auto: { kind: 'paddy', shape: 'polygon' },
  measure: { kind: 'measure', shape: 'line' },
  pin: { kind: 'pin', shape: 'point' },
};

const KIND_SHAPE: Record<ItemKind, EditKind> = {
  paddy: 'polygon',
  measure: 'line',
  pin: 'point',
};

const KIND_TOOL: Record<ItemKind, Tool> = {
  paddy: 'manual',
  measure: 'measure',
  pin: 'pin',
};

const EMPTY_EDIT: EditState = {
  kind: 'polygon',
  phase: 'drawing',
  vertexCount: 0,
  selectedVertex: null,
  areaSquareMeters: null,
  totalMeters: null,
  canDeleteVertex: false,
  selfIntersecting: false,
  canResume: false,
};

/**
 * 画面全体の状態と配線。
 *
 * 表示（view）と編集（edit）の 2 つのモードがあり、編集のときだけ上のツールバーが出る。
 * 選んでいるものは地図の右上のパネルに出て、名前・色・アイコンは「詳細」のシートで変える。
 */
export function startApp(): void {
  const hint = element('hint');
  const modeInputs = [...document.querySelectorAll<HTMLInputElement>('#mode input')];
  const toolInputs = [...document.querySelectorAll<HTMLInputElement>('#tools input')];
  const toolbar = element('toolbar');
  // ツールの記号は data-icon で HTML 側に書いてある。文字の上に置く。
  for (const label of document.querySelectorAll<HTMLElement>('#tools label[data-icon]')) {
    label.prepend(iconSvg(label.dataset['icon'] ?? 'crop_free', 20));
  }
  const exportButton = element<HTMLButtonElement>('export');
  const importButton = element<HTMLButtonElement>('import');
  const importFile = element<HTMLInputElement>('import-file');
  const clearItemsButton = element<HTMLButtonElement>('clear-items');
  const offlineStatus = element('offline-status');
  const offlineSaveButton = element<HTMLButtonElement>('offline-save');
  const offlineClearButton = element<HTMLButtonElement>('offline-clear');
  const drawActions = element('draw-actions');
  const finishButton = element<HTMLButtonElement>('finish-draw');
  const discardButton = element<HTMLButtonElement>('discard-draw');
  const deleteVertexButton = element<HTMLButtonElement>('delete-vertex');
  const extendLineButton = element<HTMLButtonElement>('extend-line');
  const listOpenButton = element<HTMLButtonElement>('list-open');
  const listCloseButton = element<HTMLButtonElement>('list-close');
  const settingsOnMapButton = element<HTMLButtonElement>('settings-open-map');
  const panelFields = element('panel-fields');
  const imageOpenButton = element<HTMLButtonElement>('image-open');
  const groupAddButton = element<HTMLButtonElement>('group-add');
  /** 幅の境目は CSS と同じ。ここを跨いだら、名前や色の欄の置き場所も変える。 */
  const narrowScreen = window.matchMedia('(max-width: 820px)');
  const app = element('app');
  setIcon(listOpenButton, 'list_alt');
  setIcon(listCloseButton, 'close');
  setIcon(settingsOnMapButton, 'settings');
  listOpenButton.addEventListener('click', () => app.classList.add('list-open'));
  listCloseButton.addEventListener('click', () => app.classList.remove('list-open'));

  let settings: Settings = loadSettings();

  /** 文字の大きさは CSS の倍率で効かせる。すべての font-size がこれに掛かる。 */
  function applyTextScales(current: Settings): void {
    const root = document.documentElement.style;
    root.setProperty('--ui-scale', String(TEXT_SCALE_FACTOR[current.uiScale]));
    root.setProperty('--label-scale', String(TEXT_SCALE_FACTOR[current.labelScale]));
  }

  applyTextScales(settings);
  const map: MapLibreMap = createMap(element('map'));
  // ブラウザから回す確認用の窓口。地図の状態（レイヤーの可視や濃さ）は DOM に出ないので、
  // ここから読めるようにしておく。読むだけで、アプリはこれを使わない。
  (window as unknown as { __tanboMap: MapLibreMap }).__tanboMap = map;

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
   * その時点ではまだ一覧もパネルも存在しない。
   */
  let wired = false;

  // レイヤーもソースも、スタイルができるまでは足せない。地図まわりの組み立ては
  // すべてここから始める。
  map.on('style.load', () => {
    wire();
  });

  function wire(): void {
    const editor = new ItemEditor(
      map,
      (state) => {
        const wasDrawing = edit.phase === 'drawing';
        edit = state;
        if (state.phase === 'editing') syncEditingItem(wasDrawing);
        render();
      },
      () => {
        // 確定したものから離れて、次を描き始めた。前のものは手放す。
        editingId = null;
        selectedId = null;
        listDirty = true;
        pinLayer.clearDraggable();
      }
    );
    const itemLayer = new ItemLayer(map, EDIT_FILL_LAYER_ID);
    const pinLayer = new PinLayer(map, (id) => selectItem(id));
    const labels = new MeasureLabels(map);
    const preview = new DetectPreview(map, setDetectionMasked, EDIT_FILL_LAYER_ID);
    const sidebar = new Sidebar({
      onSelect: (id) => selectItem(id),
      onToggleVisible: (id) => toggleVisible(id),
      onDelete: (id) => removeItem(id),
      onMoveToGroup: (id, group) => {
        updateItem(id, (item) => ({ ...item, group: group === '' ? undefined : group }));
      },
      onReorder: (group, orderedIds) => {
        // 並べ直したグループだけに番号を振る。触っていないグループは名前順のまま。
        const positions = new Map(orderedIds.map((id, at) => [id, at]));
        items = items.map((item) => {
          const at = positions.get(item.id);
          if (at === undefined) return item;
          return { ...item, group: group === NO_GROUP ? undefined : group, order: at };
        });
        listDirty = true;
        scheduleStore();
        render();
      },
      onRemoveGroup: (group) => {
        settings = {
          ...settings,
          groups: settings.groups.filter((name) => name !== group),
          collapsedGroups: settings.collapsedGroups.filter((name) => name !== group),
        };
        storeSettings(settings);
        listDirty = true;
        render();
      },
      onToggleGroup: (group) => {
        const collapsed = settings.collapsedGroups;
        settings = {
          ...settings,
          collapsedGroups: collapsed.includes(group)
            ? collapsed.filter((name) => name !== group)
            : [...collapsed, group],
        };
        storeSettings(settings);
        listDirty = true;
        render();
      },
    });
    const detail = new DetailSheet({
      onRename: (id, name) => updateItem(id, (item) => ({ ...item, name })),
      onGroup: (id, group) => {
        const trimmed = group.trim();
        updateItem(id, (item) => ({ ...item, group: trimmed === '' ? undefined : trimmed }));
      },
      onRecolor: (id, color) => {
        updateItem(id, (item) => ({ ...item, color }));
        if (id === editingId) editor.setColor(color);
      },
      onIcon: (id, icon) => updateItem(id, (item) => ({ ...item, icon })),
      onDelete: (id) => removeItem(id),
    });
    const panel = new Panel({
      onDetail: () => detail.open(),
      onDelete: (id) => removeItem(id),
      onEdit: (id) => {
        setMode('edit');
        selectItem(id);
      },
      onClose: () => {
        selectedId = null;
        listDirty = true;
        render();
      },
    });
    // 描画は crop.isOpen を読むので、render が走る前に組み立てておく。
    const crop = new CropBar(element('map'), {
      onClose: () => {
        crop.close();
        render();
      },
      onExport: (rect, format) => void saveImage(rect, format),
    });
    new SettingsSheet(settings, {
      onOverlayChange: (next) => {
        settings = next;
        applyOverlaySettings(map, settings);
        storeSettings(settings);
      },
      onTextScaleChange: (next) => {
        settings = next;
        applyTextScales(settings);
        storeSettings(settings);
      },
    });
    offlineSaveButton.addEventListener('click', () => void saveVisibleArea());
    offlineClearButton.addEventListener('click', () => void clearSavedTiles());

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
        // 絞り込んだままだと、いま描いたものが一覧に出ない。
        sidebar.resetFilter();
        editor.setColor(item.color);
      } else {
        items = items.map((item) => (item.id === editingId ? { ...item, vertices } : item));
      }
      scheduleStore();
    }

    /** いま確定できるか。最小の頂点数に届いていれば確定できる。 */
    function canFinishNow(): boolean {
      return edit.vertexCount >= minVertices(TOOLS[tool].kind);
    }

    function kindOfTool(): ItemKind {
      return TOOLS[tool].kind;
    }

    /** いまの道具で、新しく描き始める。 */
    function restartEditor(): void {
      editor.begin(TOOLS[tool].shape, defaultColor(TOOLS[tool].kind));
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
      setTool(KIND_TOOL[item.kind], false);
      editingId = item.id;
      // 一覧を描き直して、この行を「編集中の行」として掴み直す。
      // ここを飛ばすと、ドラッグや継ぎ足しのあいだ行の数値が古いまま止まる。
      listDirty = true;
      editor.load(KIND_SHAPE[item.kind], item.vertices, item.color);
      // 計測を選んで編集に入るのは、たいてい続きを測りたいとき。そのまま継ぎ足せる状態にする。
      // 置いた点は継ぎ足し中でも掴めるので、動かしたいだけのときも困らない。
      if (item.kind === 'measure') editor.resume();
      if (item.kind === 'pin') pinLayer.setDraggable(item.id, (position) => movePin(item.id, position));
    }

    function movePin(id: string, position: Vertex): void {
      items = items.map((item) => (item.id === id ? { ...item, vertices: [position] } : item));
      scheduleStore();
      render();
    }

    function fitTo(item: Item): void {
      const first = item.vertices[0];
      if (first === undefined) return;
      // 点に fitBounds は使えない（範囲が潰れる）。
      if (item.kind === 'pin') {
        map.easeTo({ center: first, duration: 400 });
        return;
      }
      const bounds = item.vertices.reduce(
        (box, vertex) => box.extend(vertex),
        new LngLatBounds(first, first)
      );
      map.fitBounds(bounds, { padding: 80, duration: 400 });
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
        restartEditor();
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
      pinLayer.clearDraggable();
      restartEditor();
      edit = EMPTY_EDIT;
      labels.clear();
    }

    // MARK: - モードとツール

    function setMode(next: AppMode): void {
      mode = next;
      for (const input of modeInputs) input.checked = input.value === next;
      toolbar.hidden = next !== 'edit';

      // 回転は表示のときだけ。編集に入るときは北へ戻す（頂点の上下左右が写真と揃う）。
      setRotationEnabled(map, next === 'view');
      if (next === 'view') {
        commitEditing();
        editor.setEnabled(false);
        preview.setEnabled(false);
      } else {
        if (map.getBearing() !== 0) map.easeTo({ bearing: 0, duration: 300 });
        editor.setEnabled(tool !== 'auto');
        preview.setEnabled(tool === 'auto');
        const item = selectedItem();
        if (item !== null) loadIntoEditor(item);
      }
      render();
    }

    function setTool(next: Tool, restart = true): void {
      // 同じ道具を押し直したときも、いま描いているものは手放す（それが「次を描く」の合図）。
      if (restart) {
        commitEditing();
        // 次を描き始めた時点で、前に選んでいたものからは離れている。
        // 残すと、描いている最中もパネルが前のものを出し続ける。
        selectedId = null;
        listDirty = true;
      }
      tool = next;
      for (const input of toolInputs) input.checked = input.value === next;

      // 自動検出のあいだはクリックを検出側に譲る。
      editor.setEnabled(mode === 'edit' && next !== 'auto');
      preview.setEnabled(mode === 'edit' && next === 'auto');
      if (next === 'auto') void loadOpenCV().catch(() => undefined);
      if (restart && next !== 'auto') restartEditor();
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

      for (const input of modeInputs) input.disabled = busy;
      for (const input of toolInputs) input.disabled = busy;
      exportButton.disabled = busy || items.length === 0;
      clearItemsButton.disabled = busy || items.length === 0;
      importButton.disabled = busy;

      itemLayer.setItems(items, selectedId, editingId);
      pinLayer.setPins(
        items.filter((item) => item.kind === 'pin' && item.visible),
        selectedId
      );

      /*
       * 計測のラベル。表示モードでは出ているものすべてに出す（測った結果は
       * 選び直さずに読めるほうがいい）。編集中はいじっている 1 本だけ——
       * 全部出すと、掴みたい頂点がラベルの下に隠れる。
       */
      if (mode === 'view') {
        labels.setLines(
          items.filter((item) => item.kind === 'measure' && item.visible).map((item) => item.vertices)
        );
      } else {
        // 引いている最中も長さは見たい。確定を待たせると、行き過ぎてから測り直すことになる。
        const liveLine = edit.kind === 'line' && edit.vertexCount > 0 ? editor.vertices : null;
        const selectedLine =
          selected?.kind === 'measure' && selected.id !== editingId ? selected.vertices : null;
        labels.setLines([liveLine ?? selectedLine ?? []].filter((line) => line.length > 0));
      }

      if (listDirty) {
        listDirty = false;
        sidebar.render(
          items,
          selectedId,
          editingId,
          settings.collapsedGroups,
          settings.groups
        );
      } else {
        sidebar.refreshLive(items);
      }
      // 確定前でも面積と長さは見たい。名前や色はまだ無いので、数値だけ出す。
      if (selected === null && edit.vertexCount > 0) {
        panel.renderDraft(edit.areaSquareMeters, edit.totalMeters);
      } else {
        // 広い画面で編集しているあいだは、名前や色の欄をパネルの中に入れる。
        // 直しながら地図を見られる。狭い画面では地図が塞がるので、シートのまま。
        const inlineFields = mode === 'edit' && selected !== null && !narrowScreen.matches;
        if (inlineFields) detail.moveFieldsTo(panelFields);
        else detail.restoreFields();
        panel.render(selected, selected !== null && selected.id === editingId, inlineFields);
      }
      // 選択が外れたら詳細のシートも閉じる。宛先のない編集欄を残さない。
      detail.render(selected, groupNames(items));
      // 画像にできるのは表示モードだけ。編集の道具と場所を取り合わせない。
      imageOpenButton.hidden = mode !== 'view' || crop.isOpen;
      // 枠を出しているあいだは、選んだものの情報も案内も引っ込める（写り込む）。
      if (crop.isOpen) {
        panel.render(null, false, false);
        hint.textContent = '地図を動かして枠に収め、「書き出す」を押します';
      }

      // キーボードも右クリックもない端末のために、同じことをボタンでもできるようにする。
      const editing = mode === 'edit' && tool !== 'auto';
      finishButton.hidden = !(editing && edit.phase === 'drawing' && canFinishNow());
      discardButton.hidden = !(editing && edit.phase === 'drawing' && edit.vertexCount > 0);
      deleteVertexButton.hidden = !(
        editing &&
        edit.phase === 'editing' &&
        edit.selectedVertex !== null &&
        edit.canDeleteVertex
      );
      // 確定した線は、末尾から点を継ぎ足せる。選び直して編集に入ったときも同じ。
      extendLineButton.hidden = !(editing && edit.canResume);
      drawActions.hidden =
        finishButton.hidden &&
        discardButton.hidden &&
        deleteVertexButton.hidden &&
        extendLineButton.hidden;
    }

    // MARK: - 地図のクリック

    finishButton.prepend(iconSvg('check', 18));
    discardButton.prepend(iconSvg('close', 18));
    deleteVertexButton.prepend(iconSvg('delete', 18));
    extendLineButton.prepend(iconSvg('add', 18));
    finishButton.addEventListener('click', () => {
      editor.finish();
      finishButton.blur();
    });
    discardButton.addEventListener('click', () => {
      editor.discard();
      discardButton.blur();
    });
    deleteVertexButton.addEventListener('click', () => {
      editor.deleteSelectedVertex();
      deleteVertexButton.blur();
    });
    extendLineButton.addEventListener('click', () => {
      editor.resume();
      extendLineButton.blur();
    });

    map.on('mousemove', (event) => {
      // クリックの検出が走っているあいだは下見を止める。同じレイヤーを隠し合う。
      if (mode === 'edit' && tool === 'auto' && detection.status !== 'running') {
        preview.moved(event.point);
      }
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
        layers: [
          ITEM_FILL_LAYER_ID,
          ITEM_CASING_LAYER_ID,
          ITEM_LINE_LAYER_ID,
          ITEM_MEASURE_LAYER_ID,
        ],
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

    async function detectAt(point: Point): Promise<void> {
      const token = (detectionToken += 1);
      // クリックした瞬間のカメラ。タイル待ちのあいだに地図を動かされると、
      // 指した場所と写真がずれる。
      const clickedCamera = cameraKey(map);
      detection = { status: 'running' };
      render();

      try {
        // 描いたものや重ねた地図が写り込むと、その線がフラッドフィルの壁になる。
        const snapshot = await captureMasked(map, setDetectionMasked);
        if (cameraKey(map) !== clickedCamera) {
          throw new DetectionError('地図が動きました。もう一度クリックしてください');
        }

        const vertices = await detectOutline(map, snapshot.whole(), point);
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
      // load は確定した状態を知らせてくるので、その場で item が 1 つできる。
      editor.load('polygon', vertices, defaultColor('paddy'));
    }

    /**
     * 自動検出が写真だけを読めるよう、描いたものと重ねた地図を隠す。
     *
     * 下見とクリックの検出は同時に走りうる。真偽値で持つと、先に終わったほうの後始末で
     * もう片方の撮影中に絵が戻り、描いた線が写り込んでフラッドフィルの壁になる。
     */
    let maskDepth = 0;
    function setDetectionMasked(masked: boolean): void {
      maskDepth = Math.max(0, maskDepth + (masked ? 1 : -1));
      applyDetectionMask(maskDepth > 0);
    }

    function applyDetectionMask(masked: boolean): void {
      itemLayer.setVisible(!masked);
      editor.setLayersVisible(!masked);
      for (const id of [PREVIEW_FILL_LAYER_ID, PREVIEW_LINE_LAYER_ID]) {
        if (map.getLayer(id) !== undefined) {
          map.setLayoutProperty(id, 'visibility', masked ? 'none' : 'visible');
        }
      }
      if (masked) {
        for (const id of OVERLAY_LAYER_IDS) {
          if (map.getLayer(id) !== undefined) map.setLayoutProperty(id, 'visibility', 'none');
        }
      } else {
        // 出す・出さないは設定が持っている。ID から引き直さない。
        applyOverlaySettings(map, settings);
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

    /*
     * 全部消す。端末を渡すときや、去年の分をまとめて片付けるときのため。
     * 消える範囲を数で言ってから聞く（「すべて」だけでは、何が消えるのか分からない）。
     */
    clearItemsButton.addEventListener('click', () => {
      if (items.length === 0) return;
      if (!confirm(`${items.length} 件をすべて削除しますか？ 書き出していないものは戻せません`)) {
        return;
      }
      detectionToken += 1;
      items = [];
      selectedId = null;
      editingId = null;
      commitEditing();
      settings = { ...settings, groups: [], collapsedGroups: [] };
      storeSettings(settings);
      notice = null;
      persist();
      listDirty = true;
      render();
    });

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
        // 読み込んだものが絞り込みで見えないと、取り込めたのかどうかが分からない。
        sidebar.resetFilter();
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

    // MARK: - グループ

    groupAddButton.prepend(iconSvg('create_new_folder', 18));
    groupAddButton.addEventListener('click', () => {
      const name = prompt('グループの名前')?.trim();
      if (name === undefined || name === '') return;
      // 同じ名前を 2 つ作らない。すでにあるなら、その見出しがそのまま入れ先になる。
      if (!settings.groups.includes(name)) {
        settings = { ...settings, groups: [...settings.groups, name] };
        storeSettings(settings);
      }
      listDirty = true;
      render();
    });

    // MARK: - 画像にする

    imageOpenButton.addEventListener('click', () => {
      crop.open();
      render();
    });

    /** 枠の中を画像にして落とす。書き出しのあいだは押し直せないようにする。 */
    async function saveImage(rect: CropRect, format: ImageFormat): Promise<void> {
      crop.setBusy(true);
      try {
        const blob = await captureImage(map, items, rect, format);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = imageFileName(new Date(), format);
        link.click();
        // click と同期で revoke すると、ブラウザによってはダウンロードが空振りする。
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch (error) {
        notice = '画像を作れませんでした';
        console.error(error);
      } finally {
        crop.setBusy(false);
        render();
      }
    }

    // MARK: - 起動

    window.addEventListener('keydown', (event) => {
      if (isTyping(event.target)) return;
      if (event.key === 'Escape' && mode === 'edit' && edit.vertexCount === 0) setMode('view');
    });


    applyOverlaySettings(map, settings);
    items = loadStored();
    listDirty = true;
    wired = true;
    setMode('view');
    void refreshOfflineStatus();
  }
}
