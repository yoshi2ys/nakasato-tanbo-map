import { expect, test } from '@playwright/test';
import {
  areaSquareMeters,
  clickMap,
  collectErrors,
  EDIT_HINT,
  EDIT_HINT_MIN,
  hint,
  openApp,
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
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('地図が用意できるまで操作を受け付けない', async ({ page }) => {
    // openApp は用意できるまで待つので、ここでは操作できることだけ確かめる。
    await expect(page.locator('#mode input[value="auto"]')).toBeEnabled();
    await expect(page.locator('#reset')).toBeDisabled();
    await expect(page.locator('#area')).toBeHidden();
    await expect(hint(page)).toHaveText('クリックで頂点を追加');
  });

  test('3 頂点に満たないうちは面積を出さない', async ({ page }) => {
    await clickMap(page, 500, 300);
    await expect(hint(page)).toHaveText('クリックで頂点を追加（Esc で最初からやり直す）');
    await expect(page.locator('#area')).toBeHidden();
    await expect(page.locator('#reset')).toBeEnabled();

    await clickMap(page, 600, 300);
    await expect(page.locator('#area')).toBeHidden();
  });

  test('2 頂点で開始点をクリックしても重複頂点を作らない', async ({ page }) => {
    await clickMap(page, 500, 300);
    await clickMap(page, 600, 300);
    await clickMap(page, 500, 300);

    // 重複頂点ができていれば 3 頂点扱いになり、面積 0 付近が出てしまう。
    await expect(page.locator('#area')).toBeHidden();
    await expect(hint(page)).toHaveText('クリックで頂点を追加（Esc で最初からやり直す）');
  });

  test('3 頂点目から暫定の面積を出す', async ({ page }) => {
    await clickMap(page, 500, 300);
    await clickMap(page, 600, 300);
    await clickMap(page, 600, 400);
    await clickMap(page, 500, 400);

    await expect(hint(page)).toHaveText('開始点をクリック / ダブルクリック / Enter で閉じる');
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

  test('ダブルクリックで閉じる', async ({ page }) => {
    await clickMap(page, 300, 500);
    await clickMap(page, 400, 500);
    await page.mouse.dblclick(350, 600);

    await expect(hint(page)).toHaveText(EDIT_HINT_MIN);
    await expect(page.locator('#area-square-meters')).toHaveText(TRIANGLE_100PX);
  });

  test('「新しく描く」の直後でも Enter は閉合として効く', async ({ page }) => {
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

  test('ボタンにフォーカスがあるときの Enter はやり直しとして扱う', async ({ page }) => {
    for (const [x, y] of [
      [300, 500],
      [400, 500],
      [350, 600],
    ] as [number, number][]) {
      await clickMap(page, x, y);
    }
    await page.locator('#reset').focus();
    await page.keyboard.press('Enter');

    await expect(hint(page)).toHaveText('クリックで頂点を追加');
    await expect(page.locator('#area')).toBeHidden();
  });

  test('Esc で描きかけを捨てる', async ({ page }) => {
    await clickMap(page, 700, 600);
    await page.keyboard.press('Escape');

    await expect(hint(page)).toHaveText('クリックで頂点を追加');
    await expect(page.locator('#reset')).toBeDisabled();
  });
});
