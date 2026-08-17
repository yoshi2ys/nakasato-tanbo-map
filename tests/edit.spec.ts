import { expect, test } from '@playwright/test';
import {
  areaSquareMeters,
  collectErrors,
  dragMap,
  drawPolygon,
  EDIT_HINT,
  EDIT_HINT_MIN,
  hint,
  openApp,
  startEditing,
} from './helpers';

/** 編集の検証に使う正方形。角の画面座標が分かっていることが大事。 */
const SQUARE: [number, number][] = [
  [400, 250],
  [800, 250],
  [800, 650],
  [400, 650],
];

test.describe('閉じたあとの頂点編集', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await startEditing(page);
    await drawPolygon(page, SQUARE);
    await expect(hint(page)).toHaveText(EDIT_HINT);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('頂点をドラッグすると面積が追従する', async ({ page }) => {
    const before = await areaSquareMeters(page);
    await dragMap(page, [800, 650], [900, 750]);

    const after = await areaSquareMeters(page);
    expect(after).toBeGreaterThan(before! * 1.05);
  });

  test('ドラッグ中も面積が更新される', async ({ page }) => {
    const before = await areaSquareMeters(page);

    await page.mouse.move(800, 650);
    await page.mouse.down();
    await page.mouse.move(600, 450, { steps: 8 });
    await page.waitForTimeout(250);
    const duringDrag = await areaSquareMeters(page);
    await page.mouse.up();

    // ボタンを離す前の時点で、すでに小さくなっていること。
    expect(duringDrag).toBeLessThan(before! * 0.9);
  });

  test('辺の中点をドラッグすると頂点が増える', async ({ page }) => {
    const before = await areaSquareMeters(page);
    // 上辺 (400,250)-(800,250) の中点。
    await dragMap(page, [600, 250], [600, 150]);

    expect(await areaSquareMeters(page)).toBeGreaterThan(before!);
  });

  test('右クリックで頂点を消す', async ({ page }) => {
    const before = await areaSquareMeters(page);
    await dragMap(page, [600, 250], [600, 150]);
    const withExtra = await areaSquareMeters(page);
    expect(withExtra).toBeGreaterThan(before!);

    await page.mouse.click(600, 150, { button: 'right' });
    await page.waitForTimeout(250);

    // 追加した頂点が消えて元の面積に戻る。
    expect(await areaSquareMeters(page)).toBeCloseTo(before!, -2);
  });

  test('選択して Delete でも頂点を消す', async ({ page }) => {
    const before = await areaSquareMeters(page);
    await page.mouse.click(400, 250);
    await page.waitForTimeout(150);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(250);

    expect(await areaSquareMeters(page)).not.toBe(before);
    await expect(hint(page)).toHaveText(EDIT_HINT_MIN);
  });

  test('3 頂点より減らせない', async ({ page }) => {
    await page.mouse.click(400, 250);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(250);
    await expect(hint(page)).toHaveText(EDIT_HINT_MIN);

    const atMinimum = await areaSquareMeters(page);
    await page.mouse.click(400, 650, { button: 'right' });
    await page.waitForTimeout(250);

    expect(await areaSquareMeters(page)).toBe(atMinimum);
  });

  test('地図の外でボタンを離してもドラッグが終わる', async ({ page }) => {
    await page.mouse.move(800, 650);
    await page.mouse.down();
    // パネルの上（地図の canvas の外）で離す。
    await page.mouse.move(150, 100, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const released = await areaSquareMeters(page);
    // 掴んだままなら、カーソルを戻すだけで頂点が追従して面積が変わる。
    await page.mouse.move(600, 500, { steps: 6 });
    await page.waitForTimeout(250);

    expect(await areaSquareMeters(page)).toBe(released);
  });

  test('交差した輪郭は面積を出さずに警告する', async ({ page }) => {
    await dragMap(page, [400, 250], [820, 640]);

    await expect(hint(page)).toHaveText('輪郭が交差しています。この面積は当てになりません');
    await expect(page.locator('#area')).toHaveClass(/unreliable/);

    // ほどけば警告も消える。
    await dragMap(page, [820, 640], [400, 250]);
    await expect(hint(page)).toHaveText(EDIT_HINT);
    await expect(page.locator('#area')).not.toHaveClass(/unreliable/);
  });
});
