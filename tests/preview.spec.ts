import { expect, test } from '@playwright/test';
import {
  collectErrors,
  hint,
  itemRows,
  openApp,
  PADDY_SEEDS,
  setMode,
  setTool,
  startEditing,
} from './helpers';

/**
 * いま下見に出ている輪郭の数。
 *
 * 画素で見ると、確定した田んぼと同じ色なので見分けられない。地図のソースを直接覗く。
 */
async function previewCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    interface MapHandle {
      queryRenderedFeatures(options: { layers: string[] }): unknown[];
    }
    const map = (window as unknown as { __tanboMap?: MapHandle }).__tanboMap;
    if (map === undefined) throw new Error('地図が公開されていません');
    // いま実際に描かれているものを数える。ソースの中身ではなく、画に出ているかを見たい。
    // 1 枚のポリゴンでもタイルをまたぐと複数に割れて返るので、数ではなく有無で使う。
    return map.queryRenderedFeatures({ layers: ['tanbo-preview-fill'] }).length;
  });
}

test.describe('自動検出の下見', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
    await startEditing(page, 'auto');
    // OpenCV.js は 13MB ある。プレビューを試す前に読み込みを済ませておく。
    await page.waitForTimeout(3000);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('カーソルを止めると輪郭が出て、クリックで確定する', async ({ page }) => {
    const seed = PADDY_SEEDS[1]!;
    expect(await previewCount(page)).toBe(0);

    await page.mouse.move(...seed);
    // 静止 200ms から検出まで、初回は撮影のぶん少し待つ。
    await expect.poll(() => previewCount(page), { timeout: 20_000 }).toBeGreaterThan(0);

    // 下見のあいだは何も作らないし、案内も変わらない。
    expect(await itemRows(page)).toHaveLength(0);
    await expect(hint(page)).toContainText('カーソルを合わせる');

    await page.mouse.click(...seed);
    await page.waitForTimeout(600);

    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('paddy');
    // 確定したら、そのまま頂点を直せる手動の編集に移る。
    await expect(page.locator('#tools input[value="manual"]')).toBeChecked();
  });

  test('地図を動かすと下見は消える', async ({ page }) => {
    await page.mouse.move(...PADDY_SEEDS[1]!);
    await expect.poll(() => previewCount(page), { timeout: 20_000 }).toBeGreaterThan(0);

    await page.mouse.move(900, 400);
    await page.mouse.down();
    await page.mouse.move(700, 500, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    // 動かしたあとの輪郭は、もう写真と合っていない。
    expect(await previewCount(page)).toBe(0);
    expect(await itemRows(page)).toHaveLength(0);
  });

  test('表示に戻ってから編集に入り直しても下見は動く', async ({ page }) => {
    await setMode(page, 'view');
    await setMode(page, 'edit');

    // 道具は自動検出のまま。ここで動かなくなると、見た目は同じなのに何も出ない。
    await expect(page.locator('#tools input[value="auto"]')).toBeChecked();
    await page.mouse.move(...PADDY_SEEDS[1]!);
    await expect.poll(() => previewCount(page), { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test('道具を離れると下見も止まる', async ({ page }) => {
    await page.mouse.move(...PADDY_SEEDS[1]!);
    await expect.poll(() => previewCount(page), { timeout: 20_000 }).toBeGreaterThan(0);

    await setTool(page, 'manual');
    await page.waitForTimeout(400);
    expect(await previewCount(page)).toBe(0);
  });
});
