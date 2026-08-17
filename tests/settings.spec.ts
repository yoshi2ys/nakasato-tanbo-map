import { expect, test } from '@playwright/test';
import {
  clickMap,
  collectErrors,
  openApp,
  openSettings,
  startEditing,
} from './helpers';

/** 実際に画面に出ている文字の大きさ（px）。 */
async function fontSize(page: import('@playwright/test').Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
}

/** 大きさの段を選ぶ。radio は隠してあるのでラベルを押す。 */
async function chooseScale(
  page: import('@playwright/test').Page,
  target: 'ui' | 'label',
  scale: 'small' | 'medium' | 'large'
): Promise<void> {
  await page.locator(`label:has(#text-${target}-${scale})`).click();
  await page.waitForTimeout(250);
}

/** 重ねる地図のレイヤーの状態を、地図そのものから読む。 */
async function overlayState(
  page: import('@playwright/test').Page,
  id: string
): Promise<{ visible: boolean; opacity: number }> {
  return page.evaluate((layerId) => {
    interface MapHandle {
      getLayoutProperty(id: string, name: string): unknown;
      getPaintProperty(id: string, name: string): unknown;
    }
    const map = (window as unknown as { __tanboMap?: MapHandle }).__tanboMap;
    if (map === undefined) throw new Error('地図が公開されていません');
    return {
      visible: map.getLayoutProperty(layerId, 'visibility') !== 'none',
      opacity: Number(map.getPaintProperty(layerId, 'raster-opacity') ?? 0),
    };
  }, id);
}

test.describe('重ねる地図', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await openSettings(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('既定では出さない', async ({ page }) => {
    for (const id of ['std', 'pale', 'hillshade']) {
      await expect(page.locator(`#overlay-${id}`)).not.toBeChecked();
      expect((await overlayState(page, `overlay-${id}`)).visible).toBe(false);
    }
  });

  test('出すとタイルを取りに行き、濃さも変えられる', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/xyz/std/')) requested.push(request.url());
    });

    await page.locator('#overlay-std').check();
    await page.waitForTimeout(1500);
    expect(requested.length).toBeGreaterThan(0);
    expect((await overlayState(page, 'overlay-std')).visible).toBe(true);

    await page.locator('#overlay-std-opacity').fill('0.2');
    await page.waitForTimeout(300);
    expect((await overlayState(page, 'overlay-std')).opacity).toBeCloseTo(0.2, 2);
  });

  test('設定は再読み込みしても残る', async ({ page }) => {
    await page.locator('#overlay-pale').check();
    await page.locator('#overlay-pale-opacity').fill('0.8');
    await page.waitForTimeout(300);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);

    expect((await overlayState(page, 'overlay-pale')).visible).toBe(true);
    expect((await overlayState(page, 'overlay-pale')).opacity).toBeCloseTo(0.8, 2);
    await openSettings(page);
    await expect(page.locator('#overlay-pale')).toBeChecked();
  });
});

test.describe('文字の大きさ', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('既定は中', async ({ page }) => {
    await openSettings(page);
    await expect(page.locator('#text-ui-medium')).toBeChecked();
    await expect(page.locator('#text-label-medium')).toBeChecked();
  });

  test('画面の文字を大きくすると、パネルの字が大きくなる', async ({ page }) => {
    const before = await fontSize(page, '#hint');

    await openSettings(page);
    await chooseScale(page, 'ui', 'large');
    expect(await fontSize(page, '#hint')).toBeGreaterThan(before);

    await chooseScale(page, 'ui', 'small');
    expect(await fontSize(page, '#hint')).toBeLessThan(before);
  });

  test('地図の文字だけを大きくできる', async ({ page }) => {
    await startEditing(page, 'measure');
    await clickMap(page, 600, 300);
    await clickMap(page, 800, 300);
    await page.locator('#finish-draw').click();
    await page.waitForTimeout(300);

    const label = await fontSize(page, '.measure-label');
    const ui = await fontSize(page, '#hint');

    await openSettings(page);
    await chooseScale(page, 'label', 'large');

    expect(await fontSize(page, '.measure-label')).toBeGreaterThan(label);
    // 画面まわりは別の設定なので、そのまま。
    expect(await fontSize(page, '#hint')).toBe(ui);
  });

  test('選んだ大きさは再読み込みしても残る', async ({ page }) => {
    await openSettings(page);
    await chooseScale(page, 'ui', 'large');
    const enlarged = await fontSize(page, '#hint');

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1000);

    expect(await fontSize(page, '#hint')).toBe(enlarged);
    await openSettings(page);
    await expect(page.locator('#text-ui-large')).toBeChecked();
  });
});

test.describe('面積の見せ方', () => {
  test('数値と単位が同じ行に並ぶ', async ({ page }) => {
    await openApp(page);
    await startEditing(page);
    await clickMap(page, 600, 300);
    await clickMap(page, 800, 300);
    await clickMap(page, 800, 450);
    await page.locator('#finish-draw').click();
    await page.waitForTimeout(300);

    // 数値と単位が離れて置かれると、目で結び付けられない。
    const primary = page.locator('#area .metric.primary');
    await expect(primary).toContainText('㎡');
    const unit = (await primary.locator('.unit').boundingBox())!;
    const value = (await primary.locator('#area-square-meters').boundingBox())!;
    // 数値のすぐ隣に単位がある。行の両端に離れていない。
    expect(unit.x - (value.x + value.width)).toBeLessThan(12);
    expect(unit.y).toBeGreaterThan(value.y);
  });
});
