import { expect, test } from '@playwright/test';
import {
  clickMap,
  closeDetail,
  collectErrors,
  itemRows,
  openApp,
  openDetail,
  selectRow,
  setMode,
  startEditing,
  startNew,
} from './helpers';

function pins(page: import('@playwright/test').Page) {
  return page.locator('.pin');
}

test.describe('ピンを立てる', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await startEditing(page, 'pin');
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('クリックした場所にピンが立ち、一覧にも入る', async ({ page }) => {
    await clickMap(page, 700, 300);
    await page.waitForTimeout(300);

    await expect(pins(page)).toHaveCount(1);
    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('pin');
    expect(rows[0]?.name).toBe('ピン 1');
    // 緯度経度がパネルに出る。
    await expect(page.locator('#panel-position')).toBeVisible();
  });

  test('名前・色・アイコンを変えられる', async ({ page }) => {
    await clickMap(page, 700, 300);
    await page.waitForTimeout(300);

    await openDetail(page);
    await page.locator('#detail-name').fill('水口');
    await page.locator('.swatch[data-color="#00acc1"]').click();
    await page.locator('.icon-choice[data-icon="water_drop"]').click();
    await page.waitForTimeout(300);

    expect((await itemRows(page))[0]?.name).toBe('水口');
    await expect(pins(page).first()).toHaveAttribute('data-icon', 'water_drop');
    await expect(pins(page).first()).toHaveCSS('color', 'rgb(0, 172, 193)');
  });

  test('編集中のピンはドラッグで動かせる', async ({ page }) => {
    await clickMap(page, 700, 300);
    await page.waitForTimeout(300);
    const before = await page.locator('#panel-position').innerText();

    await page.mouse.move(700, 300);
    await page.mouse.down();
    await page.mouse.move(820, 380, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    expect(await page.locator('#panel-position').innerText()).not.toBe(before);
  });

  test('ピンは再読み込みしても残り、表示から選べる', async ({ page }) => {
    await clickMap(page, 700, 300);
    await page.waitForTimeout(300);
    await openDetail(page);
    await page.locator('#detail-name').fill('出入口');
    await closeDetail(page);
    await startNew(page, 'pin');
    await clickMap(page, 950, 500);
    await page.waitForTimeout(700);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);

    await expect(pins(page)).toHaveCount(2);
    // 名前を変えたぶん「ピン 1」は空いているので、次のピンがそこに入る。
    expect((await itemRows(page)).map((row) => row.name)).toEqual(['出入口', 'ピン 1']);

    // 表示モードでピンを押すと選べる。
    await setMode(page, 'view');
    await pins(page).first().click();
    await page.waitForTimeout(300);
    expect((await itemRows(page))[0]?.selected).toBe(true);
  });

  test('隠したピンは地図から消える', async ({ page }) => {
    await clickMap(page, 700, 300);
    await page.waitForTimeout(300);
    await setMode(page, 'view');
    await selectRow(page, 0);

    await page.locator('#items li .item-visible').first().click();
    await page.waitForTimeout(300);
    await expect(pins(page)).toHaveCount(0);
  });
});
