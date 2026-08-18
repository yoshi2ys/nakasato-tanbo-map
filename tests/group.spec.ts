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

/** いま選んでいるものをグループへ移す。欄は編集中ならパネルの中にある。 */
async function moveToGroup(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.locator('#detail-group').fill(name);
  await page.locator('#detail-group').press('Enter');
  await page.waitForTimeout(300);
}

test.describe('一覧をグループでまとめる', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await startEditing(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('グループを使わないうちは見出しを出さない', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await expect(page.locator('.group-head')).toHaveCount(0);
    expect(await itemRows(page)).toHaveLength(1);
  });

  test('名前を打つとグループができ、空にすると未分類に戻る', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await moveToGroup(page, '大屋敷');
    await expect(page.locator('.group-head')).toHaveCount(1);
    await expect(page.locator('.group-name')).toHaveText('大屋敷');

    await moveToGroup(page, '');
    await expect(page.locator('.group-head')).toHaveCount(0);
  });

  test('未分類は最後に置く', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await moveToGroup(page, '大屋敷');
    await startNew(page);
    await drawPolygon(page, OTHER);

    await expect(page.locator('.group-name')).toHaveText(['大屋敷', '未分類']);
    await expect(page.locator('.group-count').first()).toHaveText('1');
  });

  test('見出しを押すと畳め、再読み込みしても畳んだまま', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await moveToGroup(page, '大屋敷');
    expect(await itemRows(page)).toHaveLength(1);

    await page.locator('.group-head').first().click();
    await page.waitForTimeout(300);
    expect(await itemRows(page)).toHaveLength(0);
    await expect(page.locator('.group-head').first()).toHaveAttribute('aria-expanded', 'false');

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    expect(await itemRows(page)).toHaveLength(0);
    await expect(page.locator('.group-head').first()).toHaveAttribute('aria-expanded', 'false');
  });

  test('グループは書き出しと読み込みで往復する', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await moveToGroup(page, '大屋敷');
    await page.waitForTimeout(600);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await expect(page.locator('.group-name')).toHaveText('大屋敷');
  });

  test('サイドバーから空のグループを作れる', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    // 入れ先が見えないと移しようがないので、中身が空でも見出しを出す。
    page.once('dialog', (dialog) => void dialog.accept('大屋敷'));
    await page.locator('#group-add').click();
    await page.waitForTimeout(300);

    await expect(page.locator('.group-name')).toHaveText(['大屋敷', '未分類']);
    await expect(page.locator('.group-count').first()).toHaveText('0');

    // 作ったグループは残る。
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await expect(page.locator('.group-name')).toHaveText(['大屋敷', '未分類']);
  });

  test('空のグループは消せる。中身があるうちは消せない', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    page.once('dialog', (dialog) => void dialog.accept('大屋敷'));
    await page.locator('#group-add').click();
    await page.waitForTimeout(300);
    await expect(page.locator('.group-remove')).toHaveCount(1);

    await moveToGroup(page, '大屋敷');
    // 中身が入ったら、押し間違いで丸ごと消えないよう × を出さない。
    await expect(page.locator('.group-remove')).toHaveCount(0);

    await moveToGroup(page, '');
    await page.locator('.group-remove').click();
    await page.waitForTimeout(300);
    await expect(page.locator('.group-head')).toHaveCount(0);
  });

  test('行を見出しへドラッグして移せる', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    page.once('dialog', (dialog) => void dialog.accept('大屋敷'));
    await page.locator('#group-add').click();
    await page.waitForTimeout(300);

    await page.dragAndDrop('#items li.item-row', '.group-head >> nth=0');
    await page.waitForTimeout(400);
    await expect(page.locator('.group-count').first()).toHaveText('1');
    // 未分類は空になったので、見出しごと消える。
    await expect(page.locator('.group-name')).toHaveText('大屋敷');

    // 戻すと、空になった「大屋敷」と「未分類」が並ぶ。
    await moveToGroup(page, '');
    await expect(page.locator('.group-name')).toHaveText(['大屋敷', '未分類']);
  });

  test('グループの中を手で並べ替えられる', async ({ page }) => {
    await drawPolygon(page, SQUARE);
    await page.locator('#detail-name').fill('い');
    await startNew(page);
    await drawPolygon(page, OTHER);
    await page.locator('#detail-name').fill('あ');
    await page.waitForTimeout(400);

    // 名前順なら「あ」が先。手で並べ替えたら、その並びが残る。
    expect((await itemRows(page)).map((row) => row.name)).toEqual(['あ', 'い']);

    await page.dragAndDrop(
      '#items li.item-row:has-text("い")',
      '#items li.item-row:has-text("あ")',
      { targetPosition: { x: 40, y: 2 } }
    );
    await page.waitForTimeout(400);
    expect((await itemRows(page)).map((row) => row.name)).toEqual(['い', 'あ']);

    // 並びは保存にも残る。
    await page.waitForTimeout(600);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    expect((await itemRows(page)).map((row) => row.name)).toEqual(['い', 'あ']);
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
