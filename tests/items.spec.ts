import { expect, test } from '@playwright/test';
import {
  collectErrors,
  drawPolygon,
  itemRows,
  mapPixels,
  openApp,
  openDetail,
  selectRow,
  setMode,
  startEditing,
  startNew,
  toggleRowVisible,
} from './helpers';

const SQUARE: [number, number][] = [
  [560, 250],
  [760, 250],
  [760, 400],
  [560, 400],
];

const OTHER: [number, number][] = [
  [900, 450],
  [1050, 450],
  [1050, 580],
  [900, 580],
];

test.describe('一覧から名前・色・表示を変える', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await startEditing(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('隠すと地図から消え、戻すとまた出る', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await startNew(page);
    await drawPolygon(page, OTHER);
    const drawn = await mapPixels(page, 'drawn');

    await toggleRowVisible(page, 0);
    expect((await itemRows(page))[0]?.visible).toBe(false);
    const hidden = await mapPixels(page, 'drawn');
    expect(hidden).toBeLessThan(drawn - 300);

    await toggleRowVisible(page, 0);
    expect(await mapPixels(page, 'drawn')).toBeGreaterThan(hidden + 300);
  });

  test('編集中のものは隠せない', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    // 閉じた直後は編集に載っている。ここで隠すと、頂点だけが宙に浮く。
    await expect(page.locator('#items li .item-visible').first()).toBeDisabled();
  });

  test('名前と色を変えると、一覧と地図と保存に載る', async ({ page }) => {
    // 広い画面の編集中は、名前も色もパネルの中で直に変えられる。
    await drawPolygon(page, SQUARE);
    await expect(page.locator('#panel-fields')).toBeVisible();
    await page.locator('#detail-name').fill('大屋敷の田んぼ');
    await page.waitForTimeout(200);
    expect((await itemRows(page))[0]?.name).toBe('大屋敷の田んぼ');

    // 既定の橙から緑へ。地図の色が変わったことを画素で見る。
    const orange = await mapPixels(page, 'drawn');
    expect(orange).toBeGreaterThan(300);
    await page.locator('.swatch[data-color="#43a047"]').click();
    await page.waitForTimeout(400);
    expect(await mapPixels(page, 'drawn')).toBeLessThan(orange - 200);

    await page.waitForTimeout(700);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);

    expect((await itemRows(page))[0]?.name).toBe('大屋敷の田んぼ');
    // 表示モードでは欄はシートの中。読むだけのパネルを小さく保つため。
    await selectRow(page, 0);
    await openDetail(page);
    await expect(page.locator('#detail-color')).toHaveValue('#43a047');
  });

  test('欄は、編集中はパネルの中、表示ではシートの中に置かれる', async ({ page }) => {
    await drawPolygon(page, SQUARE);

    // 編集中は触りながら直せるほうが速い。同じ欄が 2 つある状態は作らない。
    await expect(page.locator('#panel-fields #detail-name')).toBeVisible();
    await expect(page.locator('#panel-detail')).toBeHidden();
    await expect(page.locator('#panel-delete')).toBeVisible();

    await setMode(page, 'view');
    await page.waitForTimeout(300);
    await expect(page.locator('#panel-fields')).toBeHidden();
    await expect(page.locator('#panel-detail')).toBeVisible();

    await openDetail(page);
    await expect(page.locator('#detail-sheet #detail-name')).toBeVisible();
  });

  test('名前を打っているあいだの Backspace で頂点が減らない', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    const before = (await itemRows(page))[0]?.value;

    await page.locator('#detail-name').click();
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);

    // 面積が変わっていなければ、頂点は削除されていない。
    expect((await itemRows(page))[0]?.value).toBe(before);
  });
});
