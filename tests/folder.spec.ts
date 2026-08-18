import { expect, test } from '@playwright/test';
import {
  clickMap,
  collectErrors,
  drawPolygon,
  itemRows,
  openApp,
  setMode,
  startEditing,
  startNew,
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

/** いま選んでいるものをフォルダへ移す。欄は編集中ならパネルの中にある。 */
async function moveToFolder(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.locator('#detail-folder').fill(name);
  await page.locator('#detail-folder').press('Enter');
  await page.waitForTimeout(300);
}

test.describe('一覧をフォルダでまとめる', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await startEditing(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('フォルダを使わないうちは見出しを出さない', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await expect(page.locator('.folder-head')).toHaveCount(0);
    expect(await itemRows(page)).toHaveLength(1);
  });

  test('名前を打つとフォルダができ、空にすると未分類に戻る', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await moveToFolder(page, '大屋敷');
    await expect(page.locator('.folder-head')).toHaveCount(1);
    await expect(page.locator('.folder-name')).toHaveText('大屋敷');

    await moveToFolder(page, '');
    await expect(page.locator('.folder-head')).toHaveCount(0);
  });

  test('未分類は最後に置く', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await moveToFolder(page, '大屋敷');
    await startNew(page);
    await drawPolygon(page, OTHER);

    await expect(page.locator('.folder-name')).toHaveText(['大屋敷', '未分類']);
    await expect(page.locator('.folder-count').first()).toHaveText('1');
  });

  test('見出しを押すと畳め、再読み込みしても畳んだまま', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await moveToFolder(page, '大屋敷');
    expect(await itemRows(page)).toHaveLength(1);

    await page.locator('.folder-head').first().click();
    await page.waitForTimeout(300);
    expect(await itemRows(page)).toHaveLength(0);
    await expect(page.locator('.folder-head').first()).toHaveAttribute('aria-expanded', 'false');

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    expect(await itemRows(page)).toHaveLength(0);
    await expect(page.locator('.folder-head').first()).toHaveAttribute('aria-expanded', 'false');
  });

  test('フォルダは書き出しと読み込みで往復する', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await moveToFolder(page, '大屋敷');
    await page.waitForTimeout(600);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await expect(page.locator('.folder-name')).toHaveText('大屋敷');
  });

  test('名前順に並べる。数字は数として比べる', async ({ page }) => {
    // 「田んぼ 10」を先に作っても、「田んぼ 2」より後ろに来る。
    await drawPolygon(page, SQUARE);
    await page.locator('#detail-name').fill('田んぼ 10');
    await startNew(page);
    await clickMap(page, 900, 450);
    await clickMap(page, 1050, 450);
    await clickMap(page, 1050, 580);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.locator('#detail-name').fill('田んぼ 2');
    await page.waitForTimeout(400);

    await setMode(page, 'view');
    await page.waitForTimeout(300);
    expect((await itemRows(page)).map((row) => row.name)).toEqual(['田んぼ 2', '田んぼ 10']);
  });
});
