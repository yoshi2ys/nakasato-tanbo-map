import { expect, test } from '@playwright/test';
import {
  areaSquareMeters,
  clickMap,
  collectErrors,
  drawPolygon,
  mapPixels,
  EDIT_HINT,
  EDIT_HINT_MIN,
  hint,
  openApp,
  startEditing,
  startNew,
} from './helpers';

/**
 * 既定表示（ズーム 17 / 緯度 37.0525）での 1px は地上 0.4766m。
 * 100px 四方なら 2,271 ㎡ になるはずで、実測との差は測地系の違いで 0.2% 以内。
 */
const SQUARE_100PX = '2,266';
const TRIANGLE_100PX = '1,133';

test.describe('手動でポリゴンを描く', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await startEditing(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('地図が用意できるまで操作を受け付けない', async ({ page }) => {
    // openApp は用意できるまで待つので、ここでは操作できることだけ確かめる。
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled();
    await expect(page.locator('#tools input[value="manual"]')).toBeChecked();
    await expect(page.locator('#area')).toBeHidden();
    await expect(hint(page)).toHaveText('クリックで頂点を追加');
  });

  test('パネルは地図の一角に収まり、その下は地図のまま', async ({ page }) => {
    const box = async () =>
      page.evaluate(() => {
        const panel = document.getElementById('panel');
        if (panel === null || panel.hidden) return null;
        const { left, bottom, width } = panel.getBoundingClientRect();
        return { left, bottom, width };
      });

    // 何も出ていないうちは地図が全部見えている。
    expect(await box()).toBeNull();

    await drawPolygon(page, [
      [400, 300],
      [500, 300],
      [500, 400],
    ]);

    // 中身が増えても右上の一角から出ない。広がったぶんの地図は押しやられず覆われる。
    // 編集中は名前や色の欄も入るので、その幅（248px）と高さを見込む。
    const shown = (await box())!;
    expect(shown.width).toBeLessThan(280);
    expect(shown.left).toBeGreaterThan(1050);
    expect(shown.bottom).toBeLessThan(500);

    // パネルのすぐ下は地図のまま。覆われていれば、ここに置いた頂点は黙って落ちる。
    await startNew(page);
    await drawPolygon(page, [
      [shown.left + 20, shown.bottom + 30],
      [shown.left + 120, shown.bottom + 30],
      [shown.left + 120, shown.bottom + 130],
    ]);
    expect(await areaSquareMeters(page)).toBe(Number(TRIANGLE_100PX.replace(',', '')));
  });

  test('描いた輪郭が地図にも出る', async ({ page }) => {
    const before = await mapPixels(page, 'drawn');
    await drawPolygon(page, [
      [400, 300],
      [500, 300],
      [500, 400],
    ]);
    expect(await areaSquareMeters(page)).toBe(Number(TRIANGLE_100PX.replace(',', '')));
    // 面積だけ出て地図には何も出ない、という壊れ方を捕まえる。100px の三角形で実測 746px
    // （線はアンチエイリアスで縁が薄まるぶん、周長より少し多い程度）。半分を下限にする。
    expect(await mapPixels(page, 'drawn')).toBeGreaterThan(before + 370);
  });

  test('3 頂点に満たないうちは面積を出さない', async ({ page }) => {
    await clickMap(page, 500, 300);
    await expect(hint(page)).toHaveText('頂点を追加（「やめる」で最初からやり直す）');
    await expect(page.locator('#area')).toBeHidden();

    await clickMap(page, 600, 300);
    await expect(page.locator('#area')).toBeHidden();
  });

  test('2 頂点で開始点をクリックしても重複頂点を作らない', async ({ page }) => {
    await clickMap(page, 500, 300);
    await clickMap(page, 600, 300);
    await clickMap(page, 500, 300);

    // 重複頂点ができていれば 3 頂点扱いになり、面積 0 付近が出てしまう。
    await expect(page.locator('#area')).toBeHidden();
    await expect(hint(page)).toHaveText('頂点を追加（「やめる」で最初からやり直す）');
  });

  test('3 頂点目から暫定の面積を出す', async ({ page }) => {
    await clickMap(page, 500, 300);
    await clickMap(page, 600, 300);
    await clickMap(page, 600, 400);
    await clickMap(page, 500, 400);

    await expect(hint(page)).toHaveText('「確定」か、開始点をタップして閉じる');
    await expect(page.locator('#area-square-meters')).toHaveText(SQUARE_100PX);
  });

  test('開始点へのスナップで閉じる', async ({ page }) => {
    for (const [x, y] of [
      [500, 300],
      [600, 300],
      [600, 400],
      [500, 400],
    ] as [number, number][]) {
      await clickMap(page, x, y);
    }
    // 開始点そのものではなく、スナップ範囲（12px）の内側をクリックする。
    await clickMap(page, 506, 305);

    await expect(hint(page)).toHaveText(EDIT_HINT);
    await expect(page.locator('#area-square-meters')).toHaveText(SQUARE_100PX);
  });

  test('Enter で閉じる', async ({ page }) => {
    for (const [x, y] of [
      [300, 500],
      [400, 500],
      [350, 600],
    ] as [number, number][]) {
      await clickMap(page, x, y);
    }
    await page.keyboard.press('Enter');

    await expect(hint(page)).toHaveText(EDIT_HINT_MIN);
    await expect(page.locator('#area-square-meters')).toHaveText(TRIANGLE_100PX);
  });

  test('「確定」ボタンで閉じる', async ({ page }) => {
    await expect(page.locator('#finish-draw')).toBeHidden();
    await clickMap(page, 300, 500);
    await clickMap(page, 400, 500);
    // 3 頂点に満たないうちは閉じられないので、ボタンも出さない。
    await expect(page.locator('#finish-draw')).toBeHidden();

    await clickMap(page, 350, 600);
    await expect(page.locator('#finish-draw')).toBeVisible();
    await page.locator('#finish-draw').click();
    await page.waitForTimeout(250);

    await expect(hint(page)).toHaveText(EDIT_HINT_MIN);
    await expect(page.locator('#area-square-meters')).toHaveText(TRIANGLE_100PX);
    await expect(page.locator('#finish-draw')).toBeHidden();
  });

  test('ダブルクリックで閉じる', async ({ page }) => {
    await clickMap(page, 300, 500);
    await clickMap(page, 400, 500);
    await page.mouse.dblclick(350, 600);

    await expect(hint(page)).toHaveText(EDIT_HINT_MIN);
    await expect(page.locator('#area-square-meters')).toHaveText(TRIANGLE_100PX);
  });

  test('道具を押し直した直後でも Enter は閉合として効く', async ({ page }) => {
    await startNew(page);
    for (const [x, y] of [
      [300, 500],
      [400, 500],
      [350, 600],
    ] as [number, number][]) {
      await clickMap(page, x, y);
    }
    await page.keyboard.press('Enter');

    // ボタンにフォーカスが残っていると、Enter がクリックに化けて描きかけが消える。
    await expect(hint(page)).toHaveText(EDIT_HINT_MIN);
    expect(await areaSquareMeters(page)).toBeGreaterThan(0);
  });

  test('Esc で描きかけを捨てる', async ({ page }) => {
    await clickMap(page, 700, 600);
    await page.keyboard.press('Escape');

    await expect(hint(page)).toHaveText('クリックで頂点を追加');
  });
});
