import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import { midpoint, segmentLength, type Vertex } from './geometry';
import { formatDistance } from './units';

/** ラベルが重ならない最短の辺の長さ（スクリーン座標 px）。 */
const MIN_LABEL_EDGE_PIXELS = 36;

/**
 * 計測の辺の長さを、中点に出す。
 *
 * MapLibre の symbol レイヤーは字を出すのに glyphs の配信元が要るので、HTML の
 * マーカーで描く。フォントを外部から取りに行かずに済む。
 *
 * 表示モードでは出ているものすべてに、編集中はいじっている 1 本に出す。
 * 編集中に全部出すと、頂点を掴む先がラベルで隠れる。
 */
export class MeasureLabels {
  readonly #map: MapLibreMap;
  /** 鍵は「何本目の何番目の辺か」。線をまたいで同じ番号にならないようにする。 */
  readonly #labels = new Map<string, Marker>();
  #lines: Vertex[][] = [];

  constructor(map: MapLibreMap) {
    this.#map = map;
    // ラベルを出す辺はスクリーン上の長さで決まるので、ズームが変わったら引き直す。
    map.on('zoomend', this.#handleZoomEnd);
  }

  setLines(lines: Vertex[][]): void {
    this.#lines = lines;
    this.#render();
  }

  clear(): void {
    this.setLines([]);
  }

  #handleZoomEnd = (): void => {
    this.#render();
  };

  #render(): void {
    const wanted = new Map<string, { position: Vertex; text: string }>();
    for (const [line_, line] of this.#lines.entries()) {
      for (let index = 1; index < line.length; index += 1) {
        const from = line[index - 1]!;
        const to = line[index]!;
        // 画面上で短すぎる辺はラベルが重なって読めないので出さない。
        if (this.#map.project(from).dist(this.#map.project(to)) < MIN_LABEL_EDGE_PIXELS) continue;
        wanted.set(`${line_}:${index}`, {
          position: midpoint(from, to),
          text: formatDistance(segmentLength(from, to)),
        });
      }
    }

    // カーソルを動かしているあいだは毎フレームここを通る。作り直すと、そのたびに
    // DOM の入れ替えと map へのリスナ登録が走るので、同じ辺のものは使い回す。
    for (const [index, marker] of this.#labels) {
      if (wanted.has(index)) continue;
      marker.remove();
      this.#labels.delete(index);
    }
    for (const [index, { position, text }] of wanted) {
      let marker = this.#labels.get(index);
      if (marker === undefined) {
        const element = document.createElement('div');
        element.className = 'measure-label';
        marker = new Marker({ element }).setLngLat(position).addTo(this.#map);
        this.#labels.set(index, marker);
      }
      marker.setLngLat(position);
      const element = marker.getElement();
      if (element.textContent !== text) element.textContent = text;
    }
  }
}
