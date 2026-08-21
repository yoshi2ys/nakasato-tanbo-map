import { expect, test } from '@playwright/test';
import { closeSettings, collectErrors, openApp, openSettings } from './helpers';

/** 地図の中心を [経度, 緯度] で読む。 */
async function center(page: import('@playwright/test').Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __tanboMap: { getCenter: () => { lng: number; lat: number } };
    }).__tanboMap;
    const { lng, lat } = map.getCenter();
    return [lng, lat] as [number, number];
  });
}

/** 地図を別の場所へ飛ばす。ホームから離れた状態を作るため。 */
async function jumpAway(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as unknown as {
      __tanboMap: { jumpTo: (options: { center: [number, number]; zoom: number }) => void };
    }).__tanboMap;
    map.jumpTo({ center: [138.75, 37.1], zoom: 15 });
  });
  await page.waitForTimeout(300);
}

test.describe('ホーム', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  // `?c=` は開くときの一時の指定なので、ホームのボタンは既定（＝ホーム）へ戻る。
  test('ホームのボタンで、ホームの場所に戻る。向きも北へ戻る', async ({ page }) => {
    await jumpAway(page);
    await page.evaluate(() => {
      (window as unknown as { __tanboMap: { setBearing: (value: number) => void } }).__tanboMap
        .setBearing(45);
    });
    await page.locator('#home-go').click();
    await page.waitForTimeout(1200);
    const back = await center(page);
    expect(back[0]).toBeCloseTo(138.69887, 4);
    expect(back[1]).toBeCloseTo(37.05323, 4);
    const bearing = await page.evaluate(
      () =>
        (window as unknown as { __tanboMap: { getBearing: () => number } }).__tanboMap.getBearing()
    );
    expect(bearing).toBeCloseTo(0, 5);
  });

  test('覚えたホームへも戻る', async ({ page }) => {
    await jumpAway(page);
    await openSettings(page);
    await page.locator('#home-set').click();
    await page.waitForTimeout(300);
    await closeSettings(page);

    await page.evaluate(() => {
      (window as unknown as {
        __tanboMap: { jumpTo: (options: { center: [number, number]; zoom: number }) => void };
      }).__tanboMap.jumpTo({ center: [138.6, 37.0], zoom: 16 });
    });
    await page.locator('#home-go').click();
    await page.waitForTimeout(1200);
    const back = await center(page);
    expect(back[0]).toBeCloseTo(138.75, 3);
    expect(back[1]).toBeCloseTo(37.1, 3);
  });

  test('壊れたホームは無かったことにして、既定から始める', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'tanbo-map.settings',
        JSON.stringify({ home: { lng: 999, lat: 0, zoom: 17 } })
      );
    });
    await openApp(page, '');
    const opened = await center(page);
    expect(opened[0]).toBeCloseTo(138.69887, 4);
    expect(opened[1]).toBeCloseTo(37.05323, 4);
  });

  test('今の位置をホームにすると、開き直してもそこから始まる', async ({ page }) => {
    await jumpAway(page);
    await openSettings(page);
    await page.locator('#home-set').click();
    await expect(page.locator('#home-status')).toContainText('緯度 37.1');

    // 開き直しは `?c=` なしで見る（あちらが先に効くため）。
    await openApp(page, '');
    const opened = await center(page);
    expect(opened[0]).toBeCloseTo(138.75, 3);
    expect(opened[1]).toBeCloseTo(37.1, 3);
  });

  test('`?c=` はホームより先に効き、ズームは既定に戻る', async ({ page }) => {
    await page.evaluate(() => {
      const map = (window as unknown as {
        __tanboMap: { jumpTo: (options: { center: [number, number]; zoom: number }) => void };
      }).__tanboMap;
      map.jumpTo({ center: [138.75, 37.1], zoom: 20 });
    });
    await openSettings(page);
    await page.locator('#home-set').click();
    await page.waitForTimeout(300);

    // 既定の `?c=`（テストの開始位置）で開き直す。ホームではなくそちらが出る。
    await openApp(page);
    const opened = await center(page);
    expect(opened[0]).toBeCloseTo(138.70184, 4);
    const zoom = await page.evaluate(
      () => (window as unknown as { __tanboMap: { getZoom: () => number } }).__tanboMap.getZoom()
    );
    expect(zoom).toBeCloseTo(17, 5);
  });

  test('既定に戻すと、十日町の既定の位置に戻る', async ({ page }) => {
    await jumpAway(page);
    await openSettings(page);
    await page.locator('#home-set').click();
    await page.waitForTimeout(300);

    await page.locator('#home-reset').click();
    await page.waitForTimeout(300);
    await expect(page.locator('#home-status')).toContainText('既定');
    await expect(page.locator('#home-reset')).toBeDisabled();

    await closeSettings(page);
    await page.locator('#home-go').click();
    await page.waitForTimeout(1200);
    const back = await center(page);
    expect(back[0]).toBeCloseTo(138.69887, 4);
    expect(back[1]).toBeCloseTo(37.05323, 4);
  });
});
