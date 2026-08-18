import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import type { Vertex } from './geometry';
import { iconSvg } from './icons';
import { DEFAULT_ICON, isLightColor, type Item } from './items';

/**
 * ピンを地図に置く。
 *
 * canvas のレイヤーではなく HTML の Marker で描く。アイコンをレイヤーで出すには
 * 距離場（SDF）の画像を用意する必要があり、この規模の道具には重い。
 *
 * canvas に写らないので、自動検出が写真を読むときの邪魔にもならない。
 */
export class PinLayer {
  readonly #map: MapLibreMap;
  readonly #onSelect: (id: string) => void;
  readonly #markers = new Map<string, Marker>();
  #draggingId: string | null = null;
  #onMove: ((position: Vertex) => void) | null = null;

  constructor(map: MapLibreMap, onSelect: (id: string) => void) {
    this.#map = map;
    this.#onSelect = onSelect;
  }

  /** 出すピンを入れ替える。同じ id のものは作り直さず、中身だけ更新する。 */
  setPins(pins: Item[], selectedId: string | null): void {
    const wanted = new Set(pins.map((pin) => pin.id));
    for (const [id, marker] of this.#markers) {
      if (wanted.has(id)) continue;
      marker.remove();
      this.#markers.delete(id);
    }

    for (const pin of pins) {
      const position = pin.vertices[0];
      if (position === undefined) continue;

      let marker = this.#markers.get(pin.id);
      if (marker === undefined) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pin';
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          this.#onSelect(pin.id);
        });
        marker = new Marker({ element: button }).setLngLat(position).addTo(this.#map);
        this.#markers.set(pin.id, marker);
      }

      marker.setLngLat(position);
      const element = marker.getElement();
      element.style.color = pin.color;
      // 白い記号は白い地に沈む。縁を付けて輪郭を残す。
      element.classList.toggle('light', isLightColor(pin.color));
      element.title = pin.name;
      element.setAttribute('aria-label', pin.name);
      element.dataset['id'] = pin.id;
      element.classList.toggle('selected', pin.id === selectedId);

      const icon = pin.icon ?? DEFAULT_ICON;
      if (element.dataset['icon'] !== icon) {
        element.dataset['icon'] = icon;
        element.replaceChildren(iconSvg(icon, 22));
      }

      marker.setDraggable(pin.id === this.#draggingId);
    }
  }

  /**
   * 編集中のピンだけドラッグで動かせるようにする。
   * 面や線と違って頂点を掴む代わりに、ピンそのものを掴む。
   */
  setDraggable(id: string, onMove: (position: Vertex) => void): void {
    this.clearDraggable();
    this.#draggingId = id;
    this.#onMove = onMove;

    const marker = this.#markers.get(id);
    if (marker === undefined) return;
    marker.setDraggable(true);
    marker.on('drag', this.#handleDrag);
    marker.on('dragend', this.#handleDrag);
  }

  clearDraggable(): void {
    if (this.#draggingId === null) return;
    const marker = this.#markers.get(this.#draggingId);
    marker?.setDraggable(false);
    marker?.off('drag', this.#handleDrag);
    marker?.off('dragend', this.#handleDrag);
    this.#draggingId = null;
    this.#onMove = null;
  }

  #handleDrag = (): void => {
    if (this.#draggingId === null || this.#onMove === null) return;
    const marker = this.#markers.get(this.#draggingId);
    if (marker === undefined) return;
    this.#onMove(marker.getLngLat().toArray());
  };
}
