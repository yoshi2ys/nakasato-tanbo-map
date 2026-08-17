import { iconSvg } from '../icons';
import {
  isItemReliable,
  itemArea,
  itemLength,
  type Item,
  type ItemKind,
} from '../items';
import { formatArea, formatDistance } from '../units';
import { element } from './dom';

/** 一覧の行の頭に出すアイコン。ピンは選んだアイコンをそのまま使う。 */
const KIND_ICON: Record<ItemKind, string> = {
  paddy: 'crop_free',
  measure: 'straighten',
  pin: 'location_on',
};

export interface SidebarCallbacks {
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * 左の一覧。田んぼも計測もピンも、作った順に 1 本に並べる。
 * 種類ごとに分けると「さっき作ったもの」が探しにくいので、見分けはアイコンに任せる。
 */
export class Sidebar {
  readonly #list = element<HTMLUListElement>('items');
  readonly #empty = element('items-empty');
  readonly #callbacks: SidebarCallbacks;
  /** 編集中の行だけ、面積を書き換えるために覚えておく。 */
  #liveValue: HTMLElement | null = null;
  #liveId: string | null = null;

  constructor(callbacks: SidebarCallbacks) {
    this.#callbacks = callbacks;
  }

  render(items: Item[], selectedId: string | null, editingId: string | null): void {
    this.#liveValue = null;
    this.#liveId = editingId;

    this.#list.replaceChildren(
      ...items.map((item) => this.#row(item, item.id === selectedId, item.id === editingId))
    );
    this.#empty.hidden = items.length > 0;
  }

  /** ドラッグ中は一覧を作り直さず、編集中の行の数値だけ書き換える。 */
  refreshLive(items: Item[]): void {
    if (this.#liveValue === null || this.#liveId === null) return;
    const item = items.find((candidate) => candidate.id === this.#liveId);
    if (item !== undefined) this.#liveValue.textContent = valueLabel(item);
  }

  #row(item: Item, selected: boolean, editing: boolean): HTMLLIElement {
    const row = document.createElement('li');
    row.classList.toggle('selected', selected);
    row.dataset['id'] = item.id;
    row.dataset['kind'] = item.kind;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'item-select';
    select.addEventListener('click', () => this.#callbacks.onSelect(item.id));

    const icon = document.createElement('span');
    icon.className = 'item-icon';
    icon.style.color = item.color;
    icon.append(iconSvg(item.kind === 'pin' ? (item.icon ?? KIND_ICON.pin) : KIND_ICON[item.kind], 16));

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
