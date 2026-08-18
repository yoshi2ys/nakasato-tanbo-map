import { expect, test } from '@playwright/test';
import {
  clickMap,
  collectErrors,
  drawPolygon,
  itemRows,
  openApp,
  selectRow,
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

/** 田んぼ・計測・ピンを 1 つずつ置く。絞り込みは種別をまたいで効く必要がある。 */
async function drawOneOfEach(page: import('@playwright/test').Page): Promise<void> {
  await startEditing(page);
  await drawPolygon(page, SQUARE);

  await startNew(page, 'measure');
  await clickMap(page, 500, 500);
  await clickMap(page, 640, 500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);

  await startNew(page, 'pin');
  await clickMap(page, 900, 300);
  await page.waitForTimeout(300);
}

test.describe('一覧を絞り込む', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await drawOneOfEach(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('名前の一部で絞れる', async ({ page }) => {
    expect(await itemRows(page)).toHaveLength(3);

    await page.locator('#item-search').fill('計測');
    await page.waitForTimeout(200);
    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('measure');

    // 空にすれば全部戻る。絞り込みは表示だけの話で、消しているわけではない。
    await page.locator('#item-search').fill('');
    await page.waitForTimeout(200);
    expect(await itemRows(page)).toHaveLength(3);
  });

  test('種別で絞れる', async ({ page }) => {
    await page.locator('#kind-filters label:has(#kind-filter-pin)').click();
    await page.waitForTimeout(200);
    expect((await itemRows(page)).map((row) => row.kind)).toEqual(['pin']);

    await page.locator('#kind-filters label:has(#kind-filter-paddy)').click();
    await page.waitForTimeout(200);
    expect((await itemRows(page)).map((row) => row.kind)).toEqual(['paddy']);

    await page.locator('#kind-filters label:has(#kind-filter-all)').click();
    await page.waitForTimeout(200);
    expect(await itemRows(page)).toHaveLength(3);
  });

  test('語と種別は重ねて効く', async ({ page }) => {
    await page.locator('#kind-filters label:has(#kind-filter-paddy)').click();
    await page.locator('#item-search').fill('ピン');
    await page.waitForTimeout(200);

    expect(await itemRows(page)).toHaveLength(0);
    // 1 つも無いのか、絞り込みで消えたのかで、次にすることが違う。
    await expect(page.locator('#items-empty')).toHaveText('当てはまるものがありません。');
  });

  test('新しく描き始めると、パネルは下書きに切り替わる', async ({ page }) => {
    // 直前に置いたピンが選ばれたまま。ここで次を描き始めたら、パネルの中身は
    // 前のものではなく、いま描いているものでなければならない。
    await expect(page.locator('#panel-name')).toHaveText('ピン 1');

    await startNew(page);
    await clickMap(page, 500, 250);
    await clickMap(page, 620, 250);
    await clickMap(page, 620, 350);
    await page.waitForTimeout(250);

    await expect(page.locator('#panel-name')).toHaveText('田んぼ');
    await expect(page.locator('#panel-actions')).toBeHidden();
  });

  test('描いたものが絞り込みで隠れないよう、作ったら絞り込みを外す', async ({ page }) => {
    await page.locator('#item-search').fill('ピン');
    await page.locator('#kind-filters label:has(#kind-filter-pin)').click();
    await page.waitForTimeout(200);
    expect((await itemRows(page)).map((row) => row.kind)).toEqual(['pin']);

    // 絞り込んだまま次を描くと、保存できたのかどうかが読めなくなる。
    await startNew(page);
    await clickMap(page, 500, 250);
    await clickMap(page, 620, 250);
    await clickMap(page, 620, 350);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    expect((await itemRows(page)).map((row) => row.kind)).toEqual([
      'paddy',
      'measure',
      'pin',
      'paddy',
    ]);
    await expect(page.locator('#item-search')).toHaveValue('');
    await expect(page.locator('#kind-filter-all')).toBeChecked();
  });

  test('絞り込んでも選んでいるものは外れない', async ({ page }) => {
    await setMode(page, 'view');
    await selectRow(page, 0);
    await expect(page.locator('#panel')).toBeVisible();

    // 一覧から消えても、地図とパネルはそのまま。見ているものを勝手に手放さない。
    await page.locator('#kind-filters label:has(#kind-filter-pin)').click();
    await page.waitForTimeout(200);
    expect((await itemRows(page)).map((row) => row.kind)).toEqual(['pin']);
    await expect(page.locator('#panel')).toBeVisible();
    await expect(page.locator('#panel-name')).toHaveText('田んぼ 1');
  });
});
