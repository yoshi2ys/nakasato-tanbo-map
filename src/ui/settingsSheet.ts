import { OVERLAYS } from '../overlays';
import { TEXT_SCALES, type Settings, type TextScale } from '../settings';
import { element, setIcon } from './dom';

export interface SettingsCallbacks {
  onOverlayChange: (settings: Settings) => void;
  onTextScaleChange: (settings: Settings) => void;
}

const SCALE_LABEL: Record<TextScale, string> = { small: '小', medium: '中', large: '大' };

/** どの文字を変えるか。画面まわりと、地図に出る文字を分けて選べる。 */
const SCALE_ROWS: { key: 'uiScale' | 'labelScale'; label: string; id: string }[] = [
  { key: 'uiScale', label: '画面の文字', id: 'ui' },
  { key: 'labelScale', label: '地図の文字', id: 'label' },
];

/**
 * 設定のシート。重ねる地図の切り替えと濃さ、オフライン用に落とした地図の量と削除。
 */
export class SettingsSheet {
  readonly #root = element('settings');
  readonly #openButton = element<HTMLButtonElement>('settings-open');
  /** 狭い画面のときだけ地図の上に出るほう。左の列が引っ込んでいても設定に入れる。 */
  readonly #openOnMapButton = element<HTMLButtonElement>('settings-open-map');
  readonly #closeButton = element<HTMLButtonElement>('settings-close');
  readonly #list = element('overlay-list');
  readonly #textScales = element('text-scales');
  readonly #callbacks: SettingsCallbacks;
  #settings: Settings;

  constructor(settings: Settings, callbacks: SettingsCallbacks) {
    this.#settings = settings;
    this.#callbacks = callbacks;
    setIcon(this.#openButton, 'settings');
    setIcon(this.#closeButton, 'close');

    this.#openButton.addEventListener('click', () => this.open());
    this.#openOnMapButton.addEventListener('click', () => this.open());
    this.#closeButton.addEventListener('click', () => this.close());
    // 背景を押したら閉じる。シートの内側は素通しにする。
    this.#root.addEventListener('click', (event) => {
      if (event.target === this.#root) this.close();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.#root.hidden) this.close();
    });

    this.#build();
    this.#buildTextScales();
  }

  open(): void {
    this.#root.hidden = false;
  }

  close(): void {
    this.#root.hidden = true;
  }

  #buildTextScales(): void {
    this.#textScales.replaceChildren(
      ...SCALE_ROWS.map((row) => {
        const line = document.createElement('div');
        line.className = 'scale-row';

        const name = document.createElement('span');
        name.textContent = row.label;

        const choices = document.createElement('div');
        choices.className = 'scale-choices';
        choices.setAttribute('role', 'radiogroup');
        choices.setAttribute('aria-label', row.label);

        for (const scale of TEXT_SCALES) {
          const label = document.createElement('label');
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = `text-${row.id}`;
          input.value = scale;
          input.id = `text-${row.id}-${scale}`;
          input.checked = this.#settings[row.key] === scale;
          input.addEventListener('change', () => {
            if (!input.checked) return;
            this.#settings[row.key] = scale;
            this.#callbacks.onTextScaleChange(this.#settings);
          });
          const text = document.createElement('span');
          text.textContent = SCALE_LABEL[scale];
          label.append(input, text);
          choices.append(label);
        }

        line.append(name, choices);
        return line;
      })
    );
  }

  #build(): void {
    this.#list.replaceChildren(
      ...OVERLAYS.map((overlay) => {
        const setting = this.#settings.overlays[overlay.id];
        const row = document.createElement('div');
        row.className = 'overlay-row';

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'overlay-toggle';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = setting.on;
        toggle.id = `overlay-${overlay.id}`;
        const name = document.createElement('span');
        name.textContent = overlay.label;
        toggleLabel.append(toggle, name);

        const opacity = document.createElement('input');
        opacity.type = 'range';
        opacity.min = '0';
        opacity.max = '1';
        opacity.step = '0.05';
        opacity.value = String(setting.opacity);
        opacity.id = `overlay-${overlay.id}-opacity`;
        opacity.setAttribute('aria-label', `${overlay.label}の濃さ`);
        opacity.disabled = !setting.on;

        toggle.addEventListener('change', () => {
          setting.on = toggle.checked;
          opacity.disabled = !toggle.checked;
          this.#callbacks.onOverlayChange(this.#settings);
        });
        opacity.addEventListener('input', () => {
          setting.opacity = Number(opacity.value);
          this.#callbacks.onOverlayChange(this.#settings);
        });

        row.append(toggleLabel, opacity);
        return row;
      })
    );
  }
}
