import { OVERLAYS } from '../overlays';
import type { Settings } from '../settings';
import { element, setIcon } from './dom';

export interface SettingsCallbacks {
  onOverlayChange: (settings: Settings) => void;
}

/**
 * 設定のシート。重ねる地図の切り替えと濃さ、オフライン用に落とした地図の量と削除。
 */
export class SettingsSheet {
  readonly #root = element('settings');
  readonly #openButton = element<HTMLButtonElement>('settings-open');
  readonly #closeButton = element<HTMLButtonElement>('settings-close');
  readonly #list = element('overlay-list');
  readonly #callbacks: SettingsCallbacks;
  #settings: Settings;

  constructor(settings: Settings, callbacks: SettingsCallbacks) {
    this.#settings = settings;
    this.#callbacks = callbacks;
    setIcon(this.#openButton, 'settings');
    setIcon(this.#closeButton, 'close');

    this.#openButton.addEventListener('click', () => this.open());
    this.#closeButton.addEventListener('click', () => this.close());
    // 背景を押したら閉じる。シートの内側は素通しにする。
    this.#root.addEventListener('click', (event) => {
      if (event.target === this.#root) this.close();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.#root.hidden) this.close();
    });

    this.#build();
  }

  open(): void {
    this.#root.hidden = false;
  }

  close(): void {
    this.#root.hidden = true;
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
