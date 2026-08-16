import { expect, test } from '@playwright/test';
import { clickMap, collectErrors, dragMap, hint, openApp } from './helpers';

/**
 * 既定表示（ズーム 17 / 緯度 37.0525）での 1px は地上 0.4766m。
 * 100px の線は 47.66m になるはずで、実測との差は測地系の違いで 0.2% 以内。
 */
const HORIZONTAL_100PX = '47.6 m';
const VERTICAL_200PX = '95.2 m';

async function chooseMeasure(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#mode label:has(input[value="measure"])').click();
}

function labels(page: import('@playwright/test').Page) {
  return page.locator('.measure-label');
}

test.describe('地図上で距離を測る', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await chooseMeasure(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('まだ何も置いていないうちは合計を出さない', async ({ page }) => {
    await expect(hint(page)).toHaveText('クリックした点から点までの距離を測ります');
    await expect(page.locator('#measure')).toBeHidden();
    await expect(page.locator('#reset')).toBeDisabled();
  });

  test('2 点で距離が出る', async ({ page }) => {
    await clickMap(page, 400, 300);
    // 1 点では Enter もダブルクリックも効かないので、そう案内しない。
    await expect(hint(page)).toHaveText('もう 1 点クリックすると距離が出ます（Esc で消去）');
    await expect(page.locator('#measure')).toBeHidden();

    await clickMap(page, 500, 300);
    await expect(page.locator('#measure-total')).toHaveText(HORIZONTAL_100PX);
  });

  test('点を継ぎ足すと合計が伸び、各辺の長さが中点に出る', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await expect(hint(page)).toHaveText(
      'クリックで点を継ぎ足し、ダブルクリック / Enter で終了（Esc で消去）'
    );
    await clickMap(page, 500, 500);

    await expect(page.locator('#measure-total')).toHaveText('143 m');
    await expect(labels(page)).toHaveCount(2);
    await expect(labels(page).nth(0)).toHaveText(HORIZONTAL_100PX);
    await expect(labels(page).nth(1)).toHaveText(VERTICAL_200PX);
  });

  test('Enter で終わり、次のクリックで測り直す', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.keyboard.press('Enter');
    await expect(hint(page)).toHaveText('クリックすると新しく測り直します（Esc で消去）');

    // 測り終えたあとのクリックは、続きではなく新しい計測の 1 点目。
    await clickMap(page, 300, 600);
    await expect(page.locator('#measure')).toBeHidden();
    await clickMap(page, 400, 600);
    await expect(page.locator('#measure-total')).toHaveText(HORIZONTAL_100PX);
  });

  test('ダブルクリックでも終わる', async ({ page }) => {
    await clickMap(page, 400, 300);
    await page.mouse.dblclick(500, 300);
    await page.waitForTimeout(250);

    await expect(hint(page)).toHaveText('クリックすると新しく測り直します（Esc で消去）');
    await expect(page.locator('#measure-total')).toHaveText(HORIZONTAL_100PX);
  });

  test('Esc とボタンのどちらでも消せる', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.keyboard.press('Escape');
    await expect(page.locator('#measure')).toBeHidden();
    await expect(labels(page)).toHaveCount(0);

    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await expect(page.locator('#reset')).toHaveText('計測を消す');
    await page.locator('#reset').click();
    await expect(page.locator('#measure')).toBeHidden();
    await expect(labels(page)).toHaveCount(0);
  });

  test('画面上で短すぎる辺にはラベルを出さない', async ({ page }) => {
    await clickMap(page, 400, 300);
    // 20px。ラベルを出すと重なって読めないので出さない。
    await clickMap(page, 420, 300);
    await expect(page.locator('#measure-total')).not.toBeEmpty();
    await expect(labels(page)).toHaveCount(0);

    await clickMap(page, 620, 300);
    await expect(labels(page)).toHaveCount(1);
  });

  test('メジャー中は面積を引っ込め、手動に戻すと戻る', async ({ page }) => {
    // 先に田んぼを 1 枚描いておく。
    await page.locator('#mode label:has(input[value="manual"])').click();
    for (const [x, y] of [
      [300, 250],
      [500, 250],
      [500, 400],
      [300, 400],
    ] as [number, number][]) {
      await clickMap(page, x, y);
    }
    await page.keyboard.press('Enter');
    await expect(page.locator('#area')).toBeVisible();

    await chooseMeasure(page);
    await expect(page.locator('#area')).toBeHidden();

    await page.locator('#mode label:has(input[value="manual"])').click();
    await expect(page.locator('#area')).toBeVisible();
  });

  test('メジャーを離れると引いた線を残さない', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await expect(labels(page)).toHaveCount(1);

    // 残すと、他のモードには消す手立てがないうえ、自動検出が写真として読んでしまう。
    await page.locator('#mode label:has(input[value="manual"])').click();
    await expect(labels(page)).toHaveCount(0);

    await chooseMeasure(page);
    await expect(page.locator('#measure')).toBeHidden();
    // 隠すだけだと古い値が DOM に残り、消えたことを確かめられない。
    await expect(page.locator('#measure-total')).toBeEmpty();
  });

  test('測り終えたあとの連打で、同じ場所に点が重ならない', async ({ page }) => {
    await clickMap(page, 400, 300);
    await clickMap(page, 500, 300);
    await page.keyboard.press('Enter');

    // 測り終えたあとのクリックは新しい計測の始まり。2 回目以降は打ち止めの合図として扱う。
    // 順番を逆にすると、同じ座標の点が 2 つ積まれて「0 m」の計測ができてしまう。
    await page.mouse.click(500, 300, { clickCount: 3 });
    await page.waitForTimeout(250);

    await expect(hint(page)).toHaveText('もう 1 点クリックすると距離が出ます（Esc で消去）');
    await expect(page.locator('#measure')).toBeHidden();

    // そのまま 2 点目を置けば、ふつうに測り続けられる。
    await clickMap(page, 600, 300);
    await expect(page.locator('#measure-total')).toHaveText(HORIZONTAL_100PX);
  });

  test('田んぼの交差警告をメジャーのヒントに持ち込まない', async ({ page }) => {
    await page.locator('#mode label:has(input[value="manual"])').click();
    for (const [x, y] of [
      [400, 250],
      [800, 250],
      [800, 650],
      [400, 650],
    ] as [number, number][]) {
      await clickMap(page, x, y);
    }
    await page.keyboard.press('Enter');
    await dragMap(page, [400, 250], [820, 640]);
    await expect(hint(page)).toContainText('交差');

    await chooseMeasure(page);
    await expect(hint(page)).toHaveText('クリックした点から点までの距離を測ります');
    await expect(hint(page)).not.toHaveClass(/warning/);
  });
});
