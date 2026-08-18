import { expect, test } from '@playwright/test';
import {
  clickMap,
  collectErrors,
  EDIT_HINT_MIN,
  hint,
  itemRows,
  openApp,
  setMode,
  startEditing,
  startNew,
  toggleRowVisible,
} from './helpers';

/**
 * 既定表示（ズーム 17 / 緯度 37.0525）での 1px は地上 0.4766m。
 * 100px の線は 47.66m になるはずで、実測との差は測地系の違いで 0.2% 以内。
 */
const HORIZONTAL_100PX = '47.6 m';
const TOTAL_200PX = '95.2 m';

function labels(page: import('@playwright/test').Page) {
  return page.locator('.measure-label');
}

test.describe('地図上で距離を測る', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await startEditing(page, 'measure');
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('まだ何も置いていないうちは合計を出さない', async ({ page }) => {
    await expect(hint(page)).toHaveText('クリックした点から点までの距離を測ります');
    await expect(page.locator('#measure')).toBeHidden();
    expect(await itemRows(page)).toHaveLength(0);
  });

  test('2 点置いて終えると、計測として一覧に残る', async ({ page }) => {
    await clickMap(page, 400, 300);
    // 1 点では Enter もダブルクリックも効かないので、そう案内しない。
    await expect(hint(page)).toHaveText('もう 1 点で距離が出ます（「やめる」で消去）');

    await clickMap(page, 500, 300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('measure');
    expect(rows[0]?.name).toBe('計測 1');
    expect(rows[0]?.value).toBe(HORIZONTAL_100PX);
    await expect(page.locator('#measure-total')).toHaveText(HORIZONTAL_100PX);
  });

  test('点を継ぎ足すと合計が伸び、各辺の長さが中点に出る', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await clickMap(page, 500, 400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    await expect(page.locator('#measure-total')).toHaveText(TOTAL_200PX);
    await expect(labels(page)).toHaveCount(2);
    await expect(labels(page).first()).toHaveText(HORIZONTAL_100PX);
  });

  test('道具を押し直すと、次の計測を別の 1 本として始める', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.keyboard.press('Enter');
    await startNew(page, 'measure');

    await expect(hint(page)).toHaveText('クリックした点から点までの距離を測ります');
    await clickMap(page, 400, 500);
    await clickMap(page, 500, 500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const rows = await itemRows(page);
    expect(rows.map((row) => row.name)).toEqual(['計測 1', '計測 2']);
  });

  test('ダブルクリックでも終わる', async ({ page }) => {
    await clickMap(page, 400, 300);
    await page.mouse.dblclick(500, 300);
    await page.waitForTimeout(300);

    await expect(hint(page)).toHaveText(EDIT_HINT_MIN);
    await expect(page.locator('#measure-total')).toHaveText(HORIZONTAL_100PX);
  });

  test('終えたあとも頂点を動かせる', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    await page.mouse.move(500, 300);
    await page.mouse.down();
    await page.mouse.move(600, 300, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const rows = await itemRows(page);
    expect(rows[0]?.value).not.toBe(HORIZONTAL_100PX);
  });

  test('画面上で短すぎる辺にはラベルを出さない', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 410, 300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    await expect(labels(page)).toHaveCount(0);
    await expect(page.locator('#measure')).toBeVisible();
  });

  test('表示モードでは、選んでいなくても長さが出る', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await expect(labels(page)).toHaveCount(1);

    // もう 1 本。編集中は、いじっている 1 本だけに出す（頂点がラベルに隠れる）。
    await clickMap(page, 400, 500);
    await clickMap(page, 560, 500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await expect(labels(page)).toHaveCount(1);

    // 測った結果は、選び直さずに読めるほうがいい。
    await setMode(page, 'view');
    await page.mouse.click(900, 650);
    await page.waitForTimeout(300);
    await expect(labels(page)).toHaveCount(2);

    // 隠したものは地図から消えるので、ラベルも消える。
    await toggleRowVisible(page, 0);
    await page.waitForTimeout(300);
    await expect(labels(page)).toHaveCount(1);
  });

  test('引いている最中も、置いた辺の長さが線の上に出る', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.waitForTimeout(200);
    // まだ確定していない。行き過ぎてから測り直さずに済むよう、その場で出す。
    await expect(labels(page)).toHaveCount(1);
    await expect(labels(page).first()).toHaveText(HORIZONTAL_100PX);

    await clickMap(page, 500, 400);
    await page.waitForTimeout(200);
    await expect(labels(page)).toHaveCount(2);
  });

  test('確定したあと、道具を押し直さずに次の 1 本を引ける', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    // 線から離れたところを押したら、次を引き始める合図。
    await clickMap(page, 400, 500);
    await clickMap(page, 560, 500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const rows = await itemRows(page);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'measure')).toBe(true);
  });

  test('選び直して編集に入ると、末尾から点を継ぎ足せる', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const before = (await itemRows(page))[0]?.value;

    // 表示に戻ってから選び直す。現地で「あとちょっと測る」はこの入り方になる。
    await setMode(page, 'view');
    await page.locator('#items li .item-select').first().click();
    await page.waitForTimeout(400);
    await setMode(page, 'edit');
    await page.waitForTimeout(300);

    await expect(page.locator('#extend-line')).toBeVisible();
    await page.locator('#extend-line').click();
    await clickMap(page, 500, 400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);

    // 増えるのは長さだけ。新しい 1 本にはならない。
    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).not.toBe(before);
  });

  test('面には継ぎ足しを出さない', async ({ page }) => {
    await startNew(page, 'manual');
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await clickMap(page, 500, 400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    // 閉じた輪郭には継ぎ足す先がない。
    await expect(page.locator('#extend-line')).toBeHidden();
  });

  test('計測は再読み込みしても残る', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500);

    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('measure');
    expect(rows[0]?.value).toBe(HORIZONTAL_100PX);
  });
});
