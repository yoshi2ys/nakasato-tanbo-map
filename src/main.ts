import './style.css';
import { PolygonDrawer, type DrawState } from './draw';
import { createMap } from './map';
import { formatArea } from './units';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} が見つかりません`);
  return found as T;
}

const hint = element('hint');
const areaList = element('area');
const areaSquareMetersValue = element('area-square-meters');
const areaTanValue = element('area-tan');
const areaSeValue = element('area-se');
const resetButton = element<HTMLButtonElement>('reset');

function render({ areaSquareMeters, closed, vertexCount }: DrawState): void {
  areaList.hidden = areaSquareMeters === null;
  if (areaSquareMeters !== null) {
    const formatted = formatArea(areaSquareMeters);
    areaSquareMetersValue.textContent = formatted.squareMeters;
    areaTanValue.textContent = formatted.tan;
    areaSeValue.textContent = formatted.se;
  }

  if (closed) {
    hint.textContent = '輪郭を閉じました';
  } else if (vertexCount >= 3) {
    hint.textContent = '開始点をクリック / ダブルクリック / Enter で閉じる';
  } else if (vertexCount >= 1) {
    hint.textContent = 'クリックで頂点を追加（Esc で最初からやり直す）';
  } else {
    hint.textContent = 'クリックで頂点を追加';
  }

  resetButton.disabled = vertexCount === 0;
}

const map = createMap(element('map'));
map.on('load', () => {
  const drawer = new PolygonDrawer(map, render);
  resetButton.addEventListener('click', () => {
    drawer.reset();
    // フォーカスが残ると、閉合したいときの Enter がボタンのクリックに化ける。
    resetButton.blur();
  });
});
