import type { Map as MapLibreMap } from 'maplibre-gl';
import { midpoint, segmentLength } from './geometry';
import { iconPath } from './icons';
import { itemIcon, type Item } from './items';
import { formatDistance } from './units';

/**
 * 画面に出ているとおりの絵を、画像として切り出す。
 *
 * 地図の canvas には写真と、田んぼ・計測の線までしか入らない。ピンと距離のラベルは
 * HTML の Marker なので、ここで 2D の文脈に描き直す。見えていたものが画像に無いと、
 * 「写し忘れた」のか「もともと無かった」のかが後から分からない。
 */

/** 切り出す比率。畑の写真は縦横どちらもあるので、正方形と 4:3 の縦横を出す。 */
export type AspectRatio = '1:1' | '4:3' | '3:4';

export const ASPECT_RATIOS: { id: AspectRatio; label: string; ratio: number }[] = [
  { id: '1:1', label: '正方形', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
];

export type ImageFormat = 'png' | 'jpeg';

/** 画面（CSS ピクセル）で見た切り出し範囲。地図の左上を原点にする。 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ピンの丸の直径（CSS ピクセル）。画面のピンと同じ大きさにする。 */
const PIN_SIZE = 30;
/** 画面上で短すぎる辺にはラベルを出さない。measureLabels.ts と同じ基準。 */
const MIN_LABEL_EDGE_PIXELS = 36;
/** 出典の帯。消すと使えない写真なので、書き出した画像にも焼き込む。 */
const CREDIT = '出典: 地理院タイル・十日町市 航空写真';

const FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif';

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

/** Material Symbols の path をそのまま描く。viewBox は 0 -960 960 960。 */
function drawIcon(
  context: CanvasRenderingContext2D,
  name: string,
  centerX: number,
  centerY: number,
  size: number,
  color: string
): void {
  const scale = size / 960;
  context.save();
  context.translate(centerX - size / 2, centerY + size / 2);
  context.scale(scale, scale);
  context.fillStyle = color;
  context.fill(new Path2D(iconPath(name)));
  context.restore();
}

function drawPin(context: CanvasRenderingContext2D, x: number, y: number, item: Item): void {
  const radius = PIN_SIZE / 2;
  context.save();
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = 'rgb(255 255 255 / 0.92)';
  context.shadowColor = 'rgb(0 0 0 / 0.35)';
  context.shadowBlur = 4;
  context.shadowOffsetY = 1;
  context.fill();
  context.restore();
  drawIcon(context, itemIcon(item), x, y, PIN_SIZE * 0.6, item.color);
}

/** 距離のラベル。画面のものと同じ、地色を敷いた白い字。 */
function drawLabel(context: CanvasRenderingContext2D, x: number, y: number, text: string): void {
  const fontSize = 11;
  context.font = `${fontSize}px ${FONT}`;
  const width = context.measureText(text).width + 12;
  const height = fontSize + 8;
  context.fillStyle = 'rgb(29 29 31 / 0.78)';
  roundedRect(context, x - width / 2, y - height / 2, width, height, 6);
  context.fill();
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, x, y);
}

function drawCredit(context: CanvasRenderingContext2D, width: number, height: number): void {
  const fontSize = 10;
  context.font = `${fontSize}px ${FONT}`;
  const textWidth = context.measureText(CREDIT).width;
  context.fillStyle = 'rgb(255 255 255 / 0.8)';
  context.fillRect(width - textWidth - 12, height - fontSize - 8, textWidth + 12, fontSize + 8);
  context.fillStyle = '#1d1d1f';
  context.textAlign = 'right';
  context.textBaseline = 'bottom';
  context.fillText(CREDIT, width - 6, height - 4);
}

/**
 * 次の描画を待つ。canvas を読むのは描かれた直後でなければならない。
 * `preserveDrawingBuffer` を入れてあるので消えはしないが、直前の操作が
 * まだ反映されていないことはある。
 */
function nextFrame(map: MapLibreMap): Promise<void> {
  return new Promise((resolve) => {
    map.once('render', () => resolve());
    map.triggerRepaint();
  });
}

/** 切り出して、ピンとラベルと出典を描き足した画像を作る。 */
export async function captureImage(
  map: MapLibreMap,
  items: Item[],
  rect: CropRect,
  format: ImageFormat
): Promise<Blob> {
  await nextFrame(map);

  const source = map.getCanvas();
  // Retina では canvas の実寸が CSS ピクセルの 2 倍ある。その解像度のまま切り出す。
  const scale = source.width / source.clientWidth;
  const out = document.createElement('canvas');
  out.width = Math.round(rect.width * scale);
  out.height = Math.round(rect.height * scale);
  const context = out.getContext('2d');
  if (context === null) throw new Error('canvas を用意できませんでした');

  // JPEG は透明を黒く塗る。写真の外側（市域外で写真が無いところ）が黒くならないように。
  if (format === 'jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, out.width, out.height);
  }

  context.drawImage(
    source,
    rect.x * scale,
    rect.y * scale,
    rect.width * scale,
    rect.height * scale,
    0,
    0,
    out.width,
    out.height
  );

  // ここから先は CSS ピクセルで考える。画素の倍率は 1 回だけ掛ける。
  context.scale(scale, scale);
  context.translate(-rect.x, -rect.y);

  for (const item of items) {
    if (!item.visible) continue;
    if (item.kind === 'measure') {
      for (let index = 1; index < item.vertices.length; index += 1) {
        const from = item.vertices[index - 1]!;
        const to = item.vertices[index]!;
        const [a, b] = [map.project(from), map.project(to)];
        if (a.dist(b) < MIN_LABEL_EDGE_PIXELS) continue;
        const at = map.project(midpoint(from, to));
        drawLabel(context, at.x, at.y, formatDistance(segmentLength(from, to)));
      }
    }
    if (item.kind === 'pin') {
      const at = map.project(item.vertices[0]!);
      drawPin(context, at.x, at.y, item);
    }
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  drawCredit(context, out.width, out.height);

  return new Promise((resolve, reject) => {
    out.toBlob(
      (blob) => (blob === null ? reject(new Error('画像を作れませんでした')) : resolve(blob)),
      format === 'png' ? 'image/png' : 'image/jpeg',
      format === 'png' ? undefined : 0.92
    );
  });
}

/** 書き出す画像の名前。同じ場所で何枚も撮るので、日付と時刻で分ける。 */
export function imageFileName(now: Date, format: ImageFormat): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
  ].join('');
  return `tanbo-${stamp}.${format === 'png' ? 'png' : 'jpg'}`;
}
