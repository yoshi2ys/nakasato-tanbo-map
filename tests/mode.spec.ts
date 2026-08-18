import { expect, test } from '@playwright/test';
import {
  clickMap,
  collectErrors,
  drawPolygon,
  hint,
  itemRows,
  openApp,
  setMode,
  setTool,
  startEditing,
} from './helpers';

const SQUARE: [number, number][] = [
  [560, 250],
  [760, 250],
  [760, 400],
  [560, 400],
];

test.describe('表示と編集を行き来する', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('表示では描けず、編集に切り替えると描ける', async ({ page }) => {
    await expect(page.locator('#toolbar')).toBeHidden();
    await clickMap(page, 600, 300);
    expect(await itemRows(page)).toHaveLength(0);

    await setMode(page, 'edit');
    await expect(page.locator('#toolbar')).toBeVisible();
    await drawPolygon(page, SQUARE);
    expect(await itemRows(page)).toHaveLength(1);
  });

  test('表示に戻ると編集の頂点は消え、地図クリックで選べる', async ({ page }) => {
    await startEditing(page);
    await drawPolygon(page, SQUARE);

    // 表示に移っても選んでいたものはそのまま。何を見ているかを見失わせない。
    await setMode(page, 'view');
    await expect(page.locator('#panel')).toBeVisible();

    // 何もないところを押すと選択が外れ、パネルごと引っ込む。
    await clickMap(page, 1300, 700);
    await page.waitForTimeout(300);
    await expect(page.locator('#panel')).toBeHidden();

    // 塗りの内側をクリックすると、その田んぼが選ばれる。
    await clickMap(page, 660, 320);
    await page.waitForTimeout(300);
    expect((await itemRows(page))[0]?.selected).toBe(true);
    await expect(page.locator('#panel')).toBeVisible();
  });

  test('道具を切り替えると、描いていたものはそこで確定する', async ({ page }) => {
    await startEditing(page);
    await drawPolygon(page, SQUARE);

    await setTool(page, 'measure');
    await expect(hint(page)).toHaveText('クリックした点から点までの距離を測ります');

    await clickMap(page, 600, 500);
    await clickMap(page, 700, 500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const rows = await itemRows(page);
    expect(rows.map((row) => row.kind)).toEqual(['paddy', 'measure']);
  });

  test('表示で選んでおくと、編集に切り替えたときそれを編集できる', async ({ page }) => {
    await startEditing(page);
    await drawPolygon(page, SQUARE);
    await setMode(page, 'view');
    await clickMap(page, 660, 320);
    await page.waitForTimeout(300);

    await setMode(page, 'edit');
    await expect(hint(page)).toContainText('頂点をドラッグで移動');
    // 選び直さなくても、その場で頂点を動かせる。
    await expect(page.locator('#tools input[value="manual"]')).toBeChecked();
  });
});
