import { iconSvg } from '../icons';
import { isItemReliable, itemArea, itemIcon, itemLength, kindLabel, type Item } from '../items';
import { formatArea, formatDistance } from '../units';
import { element, setIcon } from './dom';

export interface PanelCallbacks {
  onDetail: (id: string) => void;
  onEdit: (id: string) => void;
  onClose: () => void;
}

/**
 * 地図の右上に浮かべる情報パネル。読むためのものだけを出す。
 *
 * 名前・色・アイコン・削除は詳細のシートに置いてある。ここに全部を並べると、
 * 選ぶたびに地図の右上が塞がる（それが右の列をやめた理由でもある）。
 */
export class Panel {
  readonly #root = element('panel');
  readonly #icon = element('panel-icon');
  readonly #name = element('panel-name');
  readonly #area = element('area');
  readonly #areaSquareMeters = element('area-square-meters');
  readonly #areaTan = element('area-tan');
  readonly #areaSe = element('area-se');
  readonly #measure = element('measure');
  readonly #measureTotal = element('measure-total');
  readonly #position = element('panel-position');
  readonly #actions = element('panel-actions');
  readonly #detailButton = element<HTMLButtonElement>('panel-detail');
  readonly #editButton = element<HTMLButtonElement>('panel-edit');
  readonly #closeButton = element<HTMLButtonElement>('panel-close');
  readonly #callbacks: PanelCallbacks;
  #item: Item | null = null;

  constructor(callbacks: PanelCallbacks) {
    this.#callbacks = callbacks;
    setIcon(this.#closeButton, 'close');

    this.#detailButton.addEventListener('click', () => {
      if (this.#item !== null) this.#callbacks.onDetail(this.#item.id);
    });
    this.#editButton.addEventListener('click', () => {
      if (this.#item !== null) this.#callbacks.onEdit(this.#item.id);
    });
    this.#closeButton.addEventListener('click', () => this.#callbacks.onClose());
  }

  /**
   * まだ確定していない描きかけの数値だけを出す。
   * 名前も色もまだ無いので、種別と数値だけを使う。
   */
  renderDraft(areaSquareMeters: number | null, totalMeters: number | null): void {
    this.#item = null;
    if (areaSquareMeters === null && totalMeters === null) {
      this.#root.hidden = true;
      return;
    }

    this.#root.hidden = false;
    // 下書きは狭い画面では出さない（CSS 側で判断する）。下から出るシートが
    // 「確定」「やめる」を押し上げ、ボタンが描いている場所まで下りてくる。
    this.#root.classList.add('draft');
    this.#name.textContent = areaSquareMeters === null ? '計測' : '田んぼ';
    this.#icon.replaceChildren(iconSvg(areaSquareMeters === null ? 'straighten' : 'crop_free', 16));
    this.#icon.style.color = '';
    this.#closeButton.hidden = true;
    this.#actions.hidden = true;
    this.#position.hidden = true;
    this.#showMetrics(areaSquareMeters, totalMeters, true);
  }

  render(item: Item | null, editing: boolean): void {
    this.#item = item;
    this.#root.hidden = item === null;
    this.#root.classList.remove('draft');
    if (item === null) return;

    this.#closeButton.hidden = false;
    this.#actions.hidden = false;
    this.#name.textContent = item.name;
    this.#name.title = `${kindLabel(item.kind)}：${item.name}`;
    this.#icon.replaceChildren(iconSvg(itemIcon(item), 16));
    this.#icon.style.color = item.color;

    this.#showMetrics(itemArea(item), itemLength(item), isItemReliable(item));

    const position = item.kind === 'pin' ? item.vertices[0] : undefined;
    this.#position.hidden = position === undefined;
    if (position !== undefined) {
      this.#position.textContent = `${position[1].toFixed(6)}, ${position[0].toFixed(6)}`;
    }

    // すでに編集器に載っているものに「編集」を出しても、押す先がない。
    this.#editButton.hidden = editing;
  }

  /** 面積と長さの欄。描きかけと確定後で同じ出し方をする。 */
  #showMetrics(areaSquareMeters: number | null, totalMeters: number | null, reliable: boolean): void {
    this.#area.hidden = areaSquareMeters === null;
    this.#area.classList.toggle('unreliable', !reliable);
    if (areaSquareMeters !== null) {
      const formatted = formatArea(areaSquareMeters);
      this.#areaSquareMeters.textContent = formatted.squareMeters;
      this.#areaTan.textContent = formatted.tan;
      this.#areaSe.textContent = formatted.se;
    }
    this.#measure.hidden = totalMeters === null;
    this.#measureTotal.textContent = totalMeters === null ? '' : formatDistance(totalMeters);
  }
}
