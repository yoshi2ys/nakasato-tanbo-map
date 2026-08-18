import { iconSvg } from '../icons';
import {
  byFolder,
  byName,
  folderOf,
  NO_FOLDER,
  isItemReliable,
  isLightColor,
  itemArea,
  itemIcon,
  itemLength,
  kindLabel,
  KINDS,
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
  onToggleFolder: (folder: string) => void;
}

/**
 * 左の一覧。フォルダごとにまとめ、中は名前順に並べる。
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
    collapsed: string[]
  ): void {
    this.#items = items;
    this.#selectedId = selectedId;
    this.#editingId = editingId;
    this.#collapsed = collapsed;
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

  /** 絞り込んだ結果を、フォルダごとに並べ直す。 */
  #paint(): void {
    this.#liveValue = null;
    this.#liveId = this.#editingId;

    const shown = this.#items.filter((item) => this.#matches(item));
    const folders = new Map<string, Item[]>();
    for (const item of shown) {
      const folder = folderOf(item);
      const group = folders.get(folder);
      if (group === undefined) folders.set(folder, [item]);
      else group.push(item);
    }

    const names = [...folders.keys()].sort(byFolder);
    // フォルダを使っていないうちは見出しを出さない。1 つしかない括りに名前を付けても読む先が増えるだけ。
    const flat = names.length === 1 && names[0] === NO_FOLDER;
    this.#list.replaceChildren(
      ...(flat
        ? [...shown]
            .sort(byName)
            .map((item) =>
              this.#row(item, item.id === this.#selectedId, item.id === this.#editingId)
            )
        : names.map((folder) => this.#folder(folder, [...folders.get(folder)!].sort(byName))))
    );

    this.#empty.hidden = shown.length > 0;
    // 1 つも無いのか、絞り込みで消えたのかで、次にすることが違う。
    this.#empty.textContent = this.#items.length === 0 ? NOTHING_YET : NOTHING_MATCHED;
  }

  /** フォルダ 1 つぶん。見出しを押すと畳める。 */
  #folder(folder: string, items: Item[]): HTMLLIElement {
    const collapsed = this.#collapsed.includes(folder);
    const block = document.createElement('li');
    block.className = 'folder';
    block.dataset['folder'] = folder;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'folder-head';
    head.setAttribute('aria-expanded', String(!collapsed));
    head.addEventListener('click', () => this.#callbacks.onToggleFolder(folder));

    const mark = document.createElement('span');
    mark.className = 'folder-mark';
    // 記号は字で出す。アイコンの一覧に矢印を足すより、向きが変わる字のほうが確か。
    mark.textContent = collapsed ? '▸' : '▾';

    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder;

    const count = document.createElement('span');
    count.className = 'folder-count';
    count.textContent = String(items.length);

    head.append(mark, name, count);
    block.append(head);

    if (!collapsed) {
      const list = document.createElement('ul');
      list.className = 'folder-items';
      list.append(
        ...items.map((item) =>
          this.#row(item, item.id === this.#selectedId, item.id === this.#editingId)
        )
      );
      block.append(list);
    }
    return block;
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
