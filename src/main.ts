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

function render({
  areaSquareMeters,
  canDeleteVertex,
  mode,
  selfIntersecting,
  vertexCount,
}: DrawState): void {
  areaList.hidden = areaSquareMeters === null;
  areaList.classList.toggle('unreliable', selfIntersecting);
  if (areaSquareMeters !== null) {
    const formatted = formatArea(areaSquareMeters);
    areaSquareMetersValue.textContent = formatted.squareMeters;
    areaTanValue.textContent = formatted.tan;
    areaSeValue.textContent = formatted.se;
  }

  if (selfIntersecting) {
    hint.textContent = '輪郭が交差しています。この面積は当てになりません';
  } else if (mode === 'editing') {
    hint.textContent = canDeleteVertex
      ? '頂点をドラッグで移動、中点をクリックで追加。削除は右クリック、または選択して Delete'
      : '頂点をドラッグで移動、中点をクリックで追加（これ以上は減らせません）';
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
