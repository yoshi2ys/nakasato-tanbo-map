import { expect, test, type Page } from '@playwright/test';
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../src/settings';
import { collectErrors, dragMap, openApp, waitForApp } from './helpers';

/** 実際に出ている一覧の幅（px）。 */
async function sidebarWidth(page: Page): Promise<number> {
  return page.locator('#sidebar').evaluate((element) => element.getBoundingClientRect().width);
}

/** 掴みしろを掴んで、指定の x まで引く。 */
async function dragHandle(page: Page, toX: number): Promise<void> {
  const box = await page.locator('#sidebar-resize').boundingBox();
  if (box === null) throw new Error('掴みしろが出ていません');
  const y = box.y + box.height / 2;
  await dragMap(page, [box.x + box.width / 2, y], [toX, y]);
}

test('一覧の幅を変えられ、開き直しても残る', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  expect(await sidebarWidth(page)).toBe(260);

  await dragHandle(page, 400);
  expect(await sidebarWidth(page)).toBe(400);

  // 地図は残りを取る。幅が変わったぶん canvas も追いかける。
  const canvas = await page.locator('#map canvas').boundingBox();
  expect(canvas?.width).toBeCloseTo(page.viewportSize()!.width - 400, 0);

  await page.reload();
  await waitForApp(page, 500);
  expect(await sidebarWidth(page)).toBe(400);

  expect(errors).toEqual([]);
});

test('幅は上限と下限で止まる（地図が潰れない）', async ({ page }) => {
  await openApp(page);
  await dragHandle(page, 1200);
  expect(await sidebarWidth(page)).toBe(MAX_SIDEBAR_WIDTH);

  await dragHandle(page, 20);
  expect(await sidebarWidth(page)).toBe(MIN_SIDEBAR_WIDTH);
});
