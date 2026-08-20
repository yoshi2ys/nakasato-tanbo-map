import { iconSvg } from '../icons';
import {
  byListOrder,
  groupOf,
  NO_GROUP,
  isItemReliable,
  isLightColor,
  itemArea,
  itemIcon,
  itemLength,
  kindLabel,
  KINDS,
  orderGroups,
  type Item,
  type ItemKind,
} from '../items';
import { formatArea, formatDistance } from '../units';
import { element } from './dom';

const NOTHING_YET = 'まだありません。「編集」に切り替えて描くと、ここに並びます。';
const NOTHING_MATCHED = '当てはまるものがありません。';

/** 種別の絞り込み。「すべて」は種別を問わない。 */
type KindFilter = ItemKind | 'all';

export interface SidebarCallbacks {
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleGroup: (group: string) => void;
  /** グループごとまとめて地図から隠す・出す。 */
  onToggleGroupHidden: (group: string) => void;
  /** 行をグループへ移す。未分類へ戻すときは空文字を渡す。 */
  onMoveToGroup: (id: string, group: string) => void;
  onRemoveGroup: (group: string) => void;
  /** グループの中身を並べ直す。並んだ順の id を渡す（移してきた行も含む）。 */
  onReorder: (group: string, orderedIds: string[]) => void;
  /** グループそのものを並べ直す。並んだ順の名前を渡す（未分類は入らない）。 */
  onReorderGroups: (orderedNames: string[]) => void;
}

/**
 * 掴んでいるのがグループかどうかを、dataTransfer の型で見分ける。
 * dragover では getData が空を返す決まりなので、中身では判定できない。
 */
const GROUP_DRAG_TYPE = 'application/x-group';

/**
 * 左の一覧。グループごとにまとめ、中は名前順に並べる。
 *
 * 種類では分けない（「さっき作ったもの」が探しにくくなる）。見分けはアイコンに任せ、
 * 種類で絞りたいときは上の絞り込みを使う。
 */
export class Sidebar {
  readonly #list = element<HTMLUListElement>('items');
  readonly #empty = element('items-empty');
  readonly #search = element<HTMLInputElement>('item-search');
  readonly #kindFilters = element('kind-filters');
  readonly #callbacks: SidebarCallbacks;
  /** 編集中の行だけ、面積を書き換えるために覚えておく。 */
  #liveValue: HTMLElement | null = null;
  #liveId: string | null = null;
  /**
   * 絞り込みは一覧の見え方だけの話なので、ここで持つ。
   * アプリ側に持たせると、語を 1 文字打つたびに地図まで作り直すことになる。
   */
  #query = '';
  #kind: KindFilter = 'all';
  #items: Item[] = [];
  #selectedId: string | null = null;
  #editingId: string | null = null;
  #collapsed: string[] = [];
  /** まとめて隠してあるグループ。行の visible とは別に持つ。 */
  #hidden: string[] = [];
  /** 中身が空でも出すグループ。設定に持っている「作ったグループ」。 */
  #groups: string[] = [];
  /** 手で並べたグループの並び。ここに無い名前は名前順で後ろに続く。 */
  #groupOrder: string[] = [];

  constructor(callbacks: SidebarCallbacks) {
    this.#callbacks = callbacks;
    this.#buildKindFilters();
    this.#search.addEventListener('input', () => {
      this.#query = this.#search.value.trim();
      this.#paint();
    });
  }

  render(
    items: Item[],
    selectedId: string | null,
    editingId: string | null,
    collapsed: string[],
    hidden: string[],
    groups: string[],
    groupOrder: string[]
  ): void {
    this.#items = items;
    this.#selectedId = selectedId;
    this.#editingId = editingId;
    this.#collapsed = collapsed;
    this.#hidden = hidden;
    this.#groups = groups;
    this.#groupOrder = groupOrder;
    this.#paint();
  }

  /**
   * 絞り込みを外す。新しく作ったものが絞り込みから外れていると、
   * 描いたのに一覧に出ず、保存できたのかどうかが読めない。
   */
  resetFilter(): void {
    if (this.#query === '' && this.#kind === 'all') return;
    this.#query = '';
    this.#kind = 'all';
    this.#search.value = '';
    for (const input of this.#kindFilters.querySelectorAll('input')) {
      input.checked = input.value === 'all';
    }
    this.#paint();
  }

  /** 絞り込んだ結果を、グループごとに並べ直す。 */
  #paint(): void {
    this.#liveValue = null;
    this.#liveId = this.#editingId;

    const shown = this.#items.filter((item) => this.#matches(item));
    const groups = new Map<string, Item[]>();
    for (const item of shown) {
      const name = groupOf(item);
      const group = groups.get(name);
      if (group === undefined) groups.set(name, [item]);
      else group.push(item);
    }

    // 作っただけでまだ空のグループも見出しを出す。入れる先が見えないと移しようがない。
    for (const name of this.#groups) if (!groups.has(name)) groups.set(name, []);
    const names = orderGroups([...groups.keys()], this.#groupOrder);
    /*
     * グループを使っていないうちは見出しを出さない。1 つしかない括りに名前を付けても
     * 読む先が増えるだけ。ただし未分類を隠しているあいだは出す——見出しごと消すと、
     * 地図から消えたものを戻す押しボタンまで無くなる。
     */
    const flat = names.length === 1 && names[0] === NO_GROUP && !this.#hidden.includes(NO_GROUP);
    this.#list.replaceChildren(
      ...(flat
        ? [...shown]
            .sort(byListOrder)
            .map((item) =>
              this.#row(item, item.id === this.#selectedId, item.id === this.#editingId)
            )
        : names.map((group) => this.#group(group, [...groups.get(group)!].sort(byListOrder))))
    );

    this.#empty.hidden = shown.length > 0;
    // 1 つも無いのか、絞り込みで消えたのかで、次にすることが違う。
    this.#empty.textContent = this.#items.length === 0 ? NOTHING_YET : NOTHING_MATCHED;
  }

  /** グループ 1 つぶん。見出しを押すと畳める。 */
  #group(group: string, items: Item[]): HTMLLIElement {
    const collapsed = this.#collapsed.includes(group);
    const block = document.createElement('li');
    block.className = 'group';
    block.dataset['group'] = group;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'group-head';
    head.setAttribute('aria-expanded', String(!collapsed));
    head.addEventListener('click', () => this.#callbacks.onToggleGroup(group));

    /*
     * 見出しは 2 つの落とし先を兼ねる。行を落とせばそのグループへ移し、
     * 見出しを落とせばグループの並びを入れ替える。指では掴めないので、
     * どちらもマウスのある画面のための道。
     */
    if (group !== NO_GROUP) {
      // 未分類は掴めない。作ったグループではないので、並びの中に居場所がない。
      head.draggable = true;
      head.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(GROUP_DRAG_TYPE, group);
        if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
        head.classList.add('dragging');
      });
      head.addEventListener('dragend', () => head.classList.remove('dragging'));
    }

    head.addEventListener('dragover', (event) => {
      if (event.dataTransfer === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (!event.dataTransfer.types.includes(GROUP_DRAG_TYPE)) {
        head.classList.add('drop-target');
        return;
      }
      // 未分類は常に最後なので、その手前にしか入れない。
      const before = group === NO_GROUP || this.#beforeHalf(head, event);
      head.classList.toggle('drop-before', before);
      head.classList.toggle('drop-after', !before);
    });
    head.addEventListener('dragleave', () => {
      head.classList.remove('drop-target', 'drop-before', 'drop-after');
    });
    head.addEventListener('drop', (event) => {
      event.preventDefault();
      const before = group === NO_GROUP || this.#beforeHalf(head, event);
      head.classList.remove('drop-target', 'drop-before', 'drop-after');
      const dragged = event.dataTransfer?.getData(GROUP_DRAG_TYPE) ?? '';
      if (dragged !== '') {
        if (dragged !== group) this.#reorderGroups(dragged, group, before);
        return;
      }
      const id = event.dataTransfer?.getData('text/plain') ?? '';
      if (id !== '') this.#callbacks.onMoveToGroup(id, group === NO_GROUP ? '' : group);
    });

    const mark = document.createElement('span');
    mark.className = 'group-mark';
    // 記号は字で出す。アイコンの一覧に矢印を足すより、向きが変わる字のほうが確か。
    mark.textContent = collapsed ? '▸' : '▾';

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group;

    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(items.length);

    head.append(mark, name, count);
    block.append(head);

    /*
     * まとめて隠す。行の `visible` は触らない——触ると、また出したときに
     * 1 つずつ隠していたものまで出てくる。ここは設定側のグループの状態だけを切る。
     */
    const hidden = this.#hidden.includes(group);
    const visible = document.createElement('button');
    visible.type = 'button';
    visible.className = 'group-visible';
    visible.setAttribute('aria-pressed', String(!hidden));
    visible.append(iconSvg(hidden ? 'visibility_off' : 'visibility', 14));
    visible.title = hidden ? `${group} をまとめて出す` : `${group} をまとめて隠す`;
    visible.addEventListener('click', (event) => {
      // 見出しを押すと畳むので、こちらの押下は届かせない。
      event.stopPropagation();
      this.#callbacks.onToggleGroupHidden(group);
    });
    head.append(visible);
    block.classList.toggle('hidden-group', hidden);

    // 空になったグループだけ捨てられる。中身ごと消える削除は、押し間違いが痛い。
    if (items.length === 0 && group !== NO_GROUP) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'group-remove';
      remove.title = `${group} を消す`;
      remove.append(iconSvg('close', 14));
      remove.addEventListener('click', () => this.#callbacks.onRemoveGroup(group));
      head.append(remove);
    }

    if (!collapsed) {
      const list = document.createElement('ul');
      list.className = 'group-items';
      list.append(
        ...items.map((item) =>
          this.#row(item, item.id === this.#selectedId, item.id === this.#editingId)
        )
      );
      block.append(list);
    }
    return block;
  }

  /** 落とした場所が相手の上半分か。前に入れるか後ろに入れるかの分かれ目。 */
  #beforeHalf(element: HTMLElement, event: DragEvent): boolean {
    const box = element.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2;
  }

  /**
   * 落とされた見出しを、相手の隣に入れた並びにして知らせる。
   * 並びは画面に出ている順から作る（畳んでいても見出しは出ている）。
   */
  #reorderGroups(dragged: string, target: string, before: boolean): void {
    const names = [...this.#list.querySelectorAll<HTMLElement>('li.group')]
      .map((block) => block.dataset['group'] ?? '')
      .filter((name) => name !== '' && name !== NO_GROUP && name !== dragged);
    const at = names.indexOf(target) + (before ? 0 : 1);
    // 相手が未分類なら、その手前——つまり並びの末尾に入る。
    names.splice(at < 0 ? names.length : at, 0, dragged);
    this.#callbacks.onReorderGroups(names);
  }

  /** 落とされた行を、相手の隣に入れた並びにして知らせる。 */
  #reorder(draggedId: string, target: Item, before: boolean): void {
    const group = groupOf(target);
    const ids = this.#items
      .filter((item) => groupOf(item) === group && item.id !== draggedId)
      .sort(byListOrder)
      .map((item) => item.id);
    const at = ids.indexOf(target.id) + (before ? 0 : 1);
    ids.splice(at, 0, draggedId);
    this.#callbacks.onReorder(group, ids);
  }

  #matches(item: Item): boolean {
    if (this.#kind !== 'all' && item.kind !== this.#kind) return false;
    if (this.#query === '') return true;
    return item.name.toLowerCase().includes(this.#query.toLowerCase());
  }

  #buildKindFilters(): void {
    const choices: { value: KindFilter; label: string }[] = [
      { value: 'all', label: 'すべて' },
      ...KINDS.map((kind) => ({ value: kind as KindFilter, label: kindLabel(kind) })),
    ];

    this.#kindFilters.replaceChildren(
      ...choices.map(({ value, label }) => {
        const wrapper = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'kind-filter';
        input.value = value;
        input.id = `kind-filter-${value}`;
        input.checked = value === this.#kind;
        input.addEventListener('change', () => {
          if (!input.checked) return;
          this.#kind = value;
          this.#paint();
        });
        const text = document.createElement('span');
        text.textContent = label;
        wrapper.append(input, text);
        return wrapper;
      })
    );
  }

  /** ドラッグ中は一覧を作り直さず、編集中の行の数値だけ書き換える。 */
  refreshLive(items: Item[]): void {
    if (this.#liveValue === null || this.#liveId === null) return;
    const item = items.find((candidate) => candidate.id === this.#liveId);
    if (item !== undefined) this.#liveValue.textContent = valueLabel(item);
  }

  #row(item: Item, selected: boolean, editing: boolean): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'item-row';
    row.classList.toggle('selected', selected);
    row.dataset['id'] = item.id;
    row.dataset['kind'] = item.kind;
    // 掴んでグループの見出しへ落とせる。touch には効かないので、指のときは詳細の欄を使う。
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', item.id);
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    /*
     * 行の上半分に落としたら前、下半分なら後ろ。掴んだ行がどこに入るのかを、
     * 落とす前に線で見せる。指では掴めないので、これはマウスのある画面のための道。
     */
    row.addEventListener('dragover', (event) => {
      if (event.dataTransfer === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      // 見出しを掴んでいるあいだは、行に入る線を出さない（行には落とせない）。
      if (event.dataTransfer.types.includes(GROUP_DRAG_TYPE)) return;
      const box = row.getBoundingClientRect();
      const before = event.clientY < box.top + box.height / 2;
      row.classList.toggle('drop-before', before);
      row.classList.toggle('drop-after', !before);
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-before', 'drop-after');
    });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const box = row.getBoundingClientRect();
      const before = event.clientY < box.top + box.height / 2;
      row.classList.remove('drop-before', 'drop-after');
      const dragged = event.dataTransfer?.getData('text/plain') ?? '';
      if (dragged === '' || dragged === item.id) return;
      this.#reorder(dragged, item, before);
    });

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'item-select';
    select.addEventListener('click', () => this.#callbacks.onSelect(item.id));

    const icon = document.createElement('span');
    icon.className = 'item-icon';
    // 白い記号は白い地に沈む。その色だけは CSS に任せて灰色にする。
    const light = isLightColor(item.color);
    icon.classList.toggle('light', light);
    icon.style.color = light ? '' : item.color;
    icon.append(iconSvg(itemIcon(item), 16));

    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = item.name;

    const value = document.createElement('span');
    value.className = 'item-value';
    value.textContent = valueLabel(item);
    if (editing) this.#liveValue = value;

    select.append(icon, name, value);

    const visible = document.createElement('button');
    visible.type = 'button';
    visible.className = 'item-visible';
    visible.setAttribute('aria-pressed', String(item.visible));
    visible.append(iconSvg(item.visible ? 'visibility' : 'visibility_off', 16));
    // 編集中のものを隠すと、頂点だけが宙に浮いて何を触っているのか分からなくなる。
    visible.disabled = editing;
    visible.title = editing ? '編集中は隠せません' : item.visible ? '地図から隠す' : '地図に出す';
    visible.addEventListener('click', () => this.#callbacks.onToggleVisible(item.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'item-delete';
    remove.append(iconSvg('close', 16));
    remove.title = `${item.name} を削除`;
    remove.addEventListener('click', () => this.#callbacks.onDelete(item.id));

    row.append(select, visible, remove);
    return row;
  }
}

/** 一覧の右端に出す数値。田んぼは面積、計測は長さ、ピンは何も出さない。 */
export function valueLabel(item: Item): string {
  if (item.kind === 'paddy') {
    if (!isItemReliable(item)) return '輪郭が交差';
    return `${formatArea(itemArea(item) ?? 0).squareMeters} ㎡`;
  }
  if (item.kind === 'measure') return formatDistance(itemLength(item) ?? 0);
  return '';
}
