import { expect, test, type Page } from '@playwright/test';
import { areaSquareMeters, collectErrors, drawPolygon, openApp, setMode } from './helpers';

/** いまの向き（度）。地図の状態は DOM に出ないので、確認用の窓口から読む。 */
function bearing(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { __tanboMap: { getBearing(): number } }).__tanboMap.getBearing()
  );
}

/** 右ドラッグで回す。MapLibre の dragRotate はこの操作で効く。 */
async function rotateDrag(page: Page): Promise<void> {
  await page.mouse.move(800, 400);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(950, 400, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(300);
}

test.describe('地図の向き', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('表示では回せる', async ({ page }) => {
    expect(await bearing(page)).toBe(0);
    await rotateDrag(page);
    expect(Math.abs(await bearing(page))).toBeGreaterThan(5);
  });

  test('編集では回らない', async ({ page }) => {
    await setMode(page, 'edit');
    await rotateDrag(page);
    expect(await bearing(page)).toBe(0);

    // キーボードにも回す経路がある。ドラッグだけ塞いでも、ここから回ってしまう。
    await page.locator('#map canvas').click({ position: { x: 400, y: 400 } });
    for (let press = 0; press < 6; press += 1) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await page.waitForTimeout(500);
    expect(await bearing(page)).toBe(0);

    // コンパスはつまんで回せる（maplibre が map.setBearing を直に呼ぶ）ので、出ていないこと。
    await expect(page.locator('.maplibregl-ctrl-compass')).toBeHidden();
  });

  test('傾きはどのモードでも付かない', async ({ page }) => {
    // 傾くと「真上から見た 1px が地上で何 m か」が崩れ、自動検出の閾値が意味を失う。
    await page.locator('#map canvas').click({ position: { x: 400, y: 400 } });
    for (let press = 0; press < 6; press += 1) {
      await page.keyboard.press('Shift+ArrowUp');
    }
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() =>
        (window as unknown as { __tanboMap: { getPitch(): number } }).__tanboMap.getPitch()
      )
    ).toBe(0);
  });

  test('編集に入ると北へ戻る', async ({ page }) => {
    await rotateDrag(page);
    expect(Math.abs(await bearing(page))).toBeGreaterThan(5);

    await setMode(page, 'edit');
    await page.waitForTimeout(600);
    expect(await bearing(page)).toBe(0);
  });

  test('コンパスを押すと北へ戻る', async ({ page }) => {
    await rotateDrag(page);
    expect(Math.abs(await bearing(page))).toBeGreaterThan(5);

    await page.locator('.maplibregl-ctrl-compass').click();
    // MapLibre の resetNorth は 1 秒かけて戻す（既定値）。待ちはそれより長く取る。
    await page.waitForTimeout(1200);
    expect(await bearing(page)).toBe(0);
  });

  test('回したあとに描いても、頂点は指した場所に落ちる', async ({ page }) => {
    await rotateDrag(page);
    await setMode(page, 'edit');
    await page.waitForTimeout(600);
    expect(await bearing(page)).toBe(0);

    // 北へ戻っているので、100px の三角形は回す前と同じ面積になる（draw.spec と同じ値）。
    await drawPolygon(page, [
      [500, 300],
      [600, 300],
      [600, 400],
    ]);
    expect(await areaSquareMeters(page)).toBe(1133);
  });
});
