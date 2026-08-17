import { iconSvg, PIN_ICONS } from '../icons';
import { isItemReliable, itemArea, itemLength, type Item } from '../items';
import { formatArea, formatDistance } from '../units';
import { element, setIcon } from './dom';

/** よく使う色。1 クリックで置けるように並べる。 */
const SWATCHES = ['#ffb300', '#ff7043', '#e53935', '#8e24aa', '#3949ab', '#0071e3', '#00acc1', '#43a047', '#ffffff', '#1d1d1f'];

const KIND_LABEL = { paddy: '田んぼ', measure: '計測', pin: 'ピン' } as const;

export interface InspectorCallbacks {
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  onIcon: (id: string, icon: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/**
 * 右のインスペクタ。選んでいるものの名前・色・アイコンと、面積や長さを出す。
 *
 * 入力欄は打つそばから反映する。保存はアプリ側でまとめて遅らせる。
 */
export class Inspector {
  readonly #body = element('inspector-body');
  readonly #empty = element('inspector-empty');
  readonly #kind = element('inspector-kind');
  readonly #nameField = element('inspector-name-field');
  readonly #name = element<HTMLInputElement>('inspector-name');
  readonly #colorField = element('inspector-color-field');
  readonly #color = element<HTMLInputElement>('inspector-color');
  readonly #swatches = element('inspector-swatches');
  readonly #iconField = element('inspector-icon-field');
  readonly #icons = element('inspector-icons');
  readonly #area = element('area');
  readonly #areaSquareMeters = element('area-square-meters');
  readonly #areaTan = element('area-tan');
  readonly #areaSe = element('area-se');
  readonly #measure = element('measure');
  readonly #measureTotal = element('measure-total');
  readonly #position = element('inspector-position');
  readonly #editButton = element<HTMLButtonElement>('inspector-edit');
  readonly #deleteButton = element<HTMLButtonElement>('inspector-delete');
  readonly #closeButton = element<HTMLButtonElement>('inspector-close');
  readonly #callbacks: InspectorCallbacks;
  #item: Item | null = null;

  constructor(callbacks: InspectorCallbacks) {
    this.#callbacks = callbacks;
    setIcon(this.#closeButton, 'close');
    this.#buildSwatches();
    this.#buildIcons();

    this.#name.addEventListener('input', () => {
      if (this.#item !== null) this.#callbacks.onRename(this.#item.id, this.#name.value);
    });
    this.#color.addEventListener('input', () => {
      if (this.#item !== null) this.#callbacks.onRecolor(this.#item.id, this.#color.value);
    });
    this.#editButton.addEventListener('click', () => {
      if (this.#item !== null) this.#callbacks.onEdit(this.#item.id);
    });
    this.#deleteButton.addEventListener('click', () => {
      if (this.#item !== null) this.#callbacks.onDelete(this.#item.id);
    });
    this.#closeButton.addEventListener('click', () => this.#callbacks.onClose());
  }

  /**
   * まだ確定していない描きかけの数値だけを出す。
   * 名前も色もまだ無いので、面積と長さの欄だけを使う。
   */
  renderDraft(areaSquareMeters: number | null, totalMeters: number | null): void {
    this.#item = null;
    const empty = areaSquareMeters === null && totalMeters === null;
    this.#body.hidden = empty;
    this.#empty.hidden = !empty;
    this.#closeButton.hidden = true;
    if (empty) {
      this.#kind.textContent = '選択なし';
      return;
    }

    this.#kind.textContent = areaSquareMeters === null ? '計測' : '田んぼ';
    this.#name.value = '';
    this.#nameField.hidden = true;
    this.#colorField.hidden = true;
    this.#iconField.hidden = true;
    this.#position.hidden = true;
    this.#editButton.hidden = true;
    this.#deleteButton.hidden = true;

    this.#area.hidden = areaSquareMeters === null;
    this.#area.classList.remove('unreliable');
    if (areaSquareMeters !== null) {
      const formatted = formatArea(areaSquareMeters);
      this.#areaSquareMeters.textContent = formatted.squareMeters;
      this.#areaTan.textContent = formatted.tan;
      this.#areaSe.textContent = formatted.se;
    }
    this.#measure.hidden = totalMeters === null;
    this.#measureTotal.textContent = totalMeters === null ? '' : formatDistance(totalMeters);
  }

  render(item: Item | null, editing: boolean): void {
    this.#item = item;
    this.#body.hidden = item === null;
    this.#empty.hidden = item !== null;
    this.#closeButton.hidden = item === null;
    if (item === null) {
      this.#kind.textContent = '選択なし';
      return;
    }

    this.#nameField.hidden = false;
    this.#colorField.hidden = false;
    this.#deleteButton.hidden = false;
    this.#kind.textContent = KIND_LABEL[item.kind];
    // 打っている最中に書き戻すと、変換中の文字が消える。
    if (document.activeElement !== this.#name) this.#name.value = item.name;
    this.#color.value = item.color;
    for (const swatch of this.#swatches.children) {
      swatch.classList.toggle('selected', (swatch as HTMLElement).dataset['color'] === item.color);
    }

    this.#iconField.hidden = item.kind !== 'pin';
    for (const button of this.#icons.children) {
      const element_ = button as HTMLElement;
      element_.classList.toggle('selected', element_.dataset['icon'] === item.icon);
      element_.style.color = element_.dataset['icon'] === item.icon ? item.color : '';
    }

    const area = itemArea(item);
    const reliable = isItemReliable(item);
    this.#area.hidden = area === null;
    this.#area.classList.toggle('unreliable', !reliable);
    if (area !== null) {
      const formatted = formatArea(area);
      this.#areaSquareMeters.textContent = formatted.squareMeters;
      this.#areaTan.textContent = formatted.tan;
      this.#areaSe.textContent = formatted.se;
    }

    const length = itemLength(item);
    this.#measure.hidden = length === null;
    this.#measureTotal.textContent = length === null ? '' : formatDistance(length);

    const position = item.kind === 'pin' ? item.vertices[0] : undefined;
    this.#position.hidden = position === undefined;
    if (position !== undefined) {
      this.#position.textContent = `${position[1].toFixed(6)}, ${position[0].toFixed(6)}`;
    }

    this.#editButton.hidden = editing;
  }

  #buildSwatches(): void {
    this.#swatches.replaceChildren(
      ...SWATCHES.map((color) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'swatch';
        button.style.background = color;
        button.dataset['color'] = color;
        button.title = color;
        button.addEventListener('click', () => {
          if (this.#item !== null) this.#callbacks.onRecolor(this.#item.id, color);
        });
        return button;
      })
    );
  }

  #buildIcons(): void {
    this.#icons.replaceChildren(
      ...PIN_ICONS.map((icon) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'icon-choice';
        button.dataset['icon'] = icon;
        button.append(iconSvg(icon, 18));
        button.addEventListener('click', () => {
          if (this.#item !== null) this.#callbacks.onIcon(this.#item.id, icon);
        });
        return button;
      })
    );
  }
}
