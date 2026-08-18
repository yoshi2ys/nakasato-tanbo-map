import { iconSvg, PIN_ICONS, type IconName } from '../icons';
import { kindLabel, type Item } from '../items';
import { element, setIcon } from './dom';

/** よく使う色。1 クリックで置けるように並べる。 */
const SWATCHES = ['#ffb300', '#ff7043', '#e53935', '#8e24aa', '#3949ab', '#0071e3', '#00acc1', '#43a047', '#ffffff', '#1d1d1f'];

export interface DetailCallbacks {
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  onIcon: (id: string, icon: IconName) => void;
  onDelete: (id: string) => void;
}

/**
 * 選んでいるものの名前・色・アイコンを変えるシート。設定と同じ重ね方で出す。
 *
 * 欄そのもの（#item-fields）はパネルと共有する。広い画面で編集しているあいだは
 * パネルへ移り、ここは空になる。入力欄は打つそばから反映し、保存はアプリ側で遅らせる。
 */
export class DetailSheet {
  readonly #root = element('detail');
  readonly #heading = element('detail-heading');
  readonly #name = element<HTMLInputElement>('detail-name');
  readonly #color = element<HTMLInputElement>('detail-color');
  readonly #swatches = element('detail-swatches');
  readonly #iconField = element('detail-icon-field');
  readonly #icons = element('detail-icons');
  readonly #fields = element('item-fields');
  readonly #deleteButton = element<HTMLButtonElement>('detail-delete');
  readonly #closeButton = element<HTMLButtonElement>('detail-close');
  readonly #callbacks: DetailCallbacks;
  #item: Item | null = null;

  constructor(callbacks: DetailCallbacks) {
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
    this.#deleteButton.addEventListener('click', () => {
      if (this.#item !== null) this.#callbacks.onDelete(this.#item.id);
    });
    this.#closeButton.addEventListener('click', () => this.close());
    // 背景を押したら閉じる。シートの内側は素通しにする。
    this.#root.addEventListener('click', (event) => {
      if (event.target === this.#root) this.close();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.#root.hidden) this.close();
    });
  }

  /** 欄を引き取って、指定の場所へ移す。入力欄は同じものなので、聞き手も値も変わらない。 */
  moveFieldsTo(container: HTMLElement): void {
    if (this.#fields.parentElement === container) return;
    container.append(this.#fields);
    this.close();
  }

  /** 欄をシートへ戻す。削除ボタンの前が定位置。 */
  restoreFields(): void {
    if (this.#fields.parentElement === this.#deleteButton.parentElement) return;
    this.#deleteButton.before(this.#fields);
  }

  open(): void {
    if (this.#item === null) return;
    this.#root.hidden = false;
    this.#name.focus();
  }

  close(): void {
    this.#root.hidden = true;
  }

  get isOpen(): boolean {
    return !this.#root.hidden;
  }

  /** 選んでいるものを差し替える。選択が外れたらシートも閉じる（宛先のない編集を残さない）。 */
  render(item: Item | null): void {
    this.#item = item;
    if (item === null) {
      this.close();
      return;
    }

    this.#heading.textContent = `${kindLabel(item.kind)}の詳細`;
    // 打っている最中に書き戻すと、変換中の文字が消える。
    if (document.activeElement !== this.#name) this.#name.value = item.name;
    this.#color.value = item.color;
    for (const swatch of this.#swatches.children) {
      swatch.classList.toggle('selected', (swatch as HTMLElement).dataset['color'] === item.color);
    }

    this.#iconField.hidden = item.kind !== 'pin';
    for (const button of this.#icons.children) {
      const choice = button as HTMLElement;
      choice.classList.toggle('selected', choice.dataset['icon'] === item.icon);
      choice.style.color = choice.dataset['icon'] === item.icon ? item.color : '';
    }
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
