import { expect, test } from '@playwright/test';
import { collectErrors, openApp, openSettings } from './helpers';

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
