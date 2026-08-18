import {
  ASPECT_RATIOS,
  type AspectRatio,
  type CropRect,
  type ImageFormat,
} from '../snapshot';
import { element } from './dom';

/** 上のバーと下のバーに掛からない余白（CSS ピクセル）。枠はこの内側に収める。 */
const INSET = { top: 72, bottom: 116, side: 24 };

const FORMATS: { id: ImageFormat; label: string }[] = [
  { id: 'png', label: 'PNG' },
  { id: 'jpeg', label: 'JPEG' },
];

export interface CropCallbacks {
  onExport: (rect: CropRect, format: ImageFormat) => void;
  onClose: () => void;
}

/**
 * 画像にする範囲を決めるバーと枠。
 *
 * 枠は動かさず、地図のほうを動かして合わせる。枠を掴んで動かす作りにすると、
 * 枠の操作と地図の操作が同じ指で取り合いになる（地図は指 1 本で動かすため）。
 */
export class CropBar {
  readonly #root = element('crop');
  readonly #frame = element('crop-frame');
  readonly #bar = element('crop-bar');
  readonly #ratios = element('crop-ratios');
  readonly #formats = element('crop-formats');
  readonly #size = element<HTMLInputElement>('crop-size');
  readonly #cancel = element<HTMLButtonElement>('crop-cancel');
  readonly #run = element<HTMLButtonElement>('crop-run');
  readonly #map: HTMLElement;
  readonly #callbacks: CropCallbacks;
  #ratio: AspectRatio = '1:1';
  #format: ImageFormat = 'png';

  constructor(map: HTMLElement, callbacks: CropCallbacks) {
    this.#map = map;
    this.#callbacks = callbacks;
    this.#buildRatios();
    this.#buildFormats();

    this.#size.addEventListener('input', () => this.layout());
    this.#cancel.addEventListener('click', () => this.#callbacks.onClose());
    this.#run.addEventListener('click', () => {
      this.#callbacks.onExport(this.rect(), this.#format);
    });
    window.addEventListener('resize', () => {
      if (this.isOpen) this.layout();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) this.#callbacks.onClose();
    });
  }

  get isOpen(): boolean {
    return !this.#root.hidden;
  }

  open(): void {
    this.#root.hidden = false;
    this.#bar.hidden = false;
    this.layout();
  }

  close(): void {
    this.#root.hidden = true;
    this.#bar.hidden = true;
  }

  /** 書き出しの最中はボタンを止める。二重に走ると同じ絵が 2 枚落ちてくる。 */
  setBusy(busy: boolean): void {
    this.#run.disabled = busy;
    this.#run.textContent = busy ? '書き出し中…' : '書き出す';
  }

  /** 枠の位置と大きさを、いまの画面と比率から決める。 */
  layout(): void {
    const box = this.#map.getBoundingClientRect();
    const availableWidth = Math.max(80, box.width - INSET.side * 2);
    const availableHeight = Math.max(80, box.height - INSET.top - INSET.bottom);
    const ratio = ASPECT_RATIOS.find((entry) => entry.id === this.#ratio)?.ratio ?? 1;
    const fitWidth = Math.min(availableWidth, availableHeight * ratio);
    const share = Number(this.#size.value) / 100;
    const width = fitWidth * share;
    const height = width / ratio;

    this.#frame.style.width = `${width}px`;
    this.#frame.style.height = `${height}px`;
    this.#frame.style.left = `${(box.width - width) / 2}px`;
    this.#frame.style.top = `${INSET.top + (availableHeight - height) / 2}px`;
  }

  /** 地図の左上を原点にした、いまの枠の位置。切り出しはこの矩形で行う。 */
  rect(): CropRect {
    const frame = this.#frame.getBoundingClientRect();
    const map = this.#map.getBoundingClientRect();
    return {
      x: frame.left - map.left,
      y: frame.top - map.top,
      width: frame.width,
      height: frame.height,
    };
  }

  #buildRatios(): void {
    this.#ratios.replaceChildren(
      ...ASPECT_RATIOS.map(({ id, label }) =>
        this.#choice('crop-ratio', id, label, id === this.#ratio, () => {
          this.#ratio = id;
          this.layout();
        })
      )
    );
  }

  #buildFormats(): void {
    this.#formats.replaceChildren(
      ...FORMATS.map(({ id, label }) =>
        this.#choice('crop-format', id, label, id === this.#format, () => {
          this.#format = id;
        })
      )
    );
  }

  #choice(
    group: string,
    value: string,
    label: string,
    checked: boolean,
    onPick: () => void
  ): HTMLLabelElement {
    const wrapper = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = group;
    input.value = value;
    input.id = `${group}-${value}`;
    input.checked = checked;
    input.addEventListener('change', () => {
      if (input.checked) onPick();
    });
    const text = document.createElement('span');
    text.textContent = label;
    wrapper.append(input, text);
    return wrapper;
  }
}
