import { expect, test } from '@playwright/test';
import {
  collectErrors,
  hint,
  itemRows,
  openApp,
  PADDY_SEEDS,
  setTool,
  startEditing,
} from './helpers';

/** プレビューのポリゴンの頂点数。地図の中を覗いて数える。 */
async function previewVertices(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#map canvas');
    if (canvas === null) return 0;
    // 破線の色（#ffb300）が出ている画素を数える。プレビューは薄いので少なめに出る。
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d');
    if (context === null) return 0;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [red, green, blue] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
      if (red > 215 && green > 140 && green < 205 && blue < 70) count += 1;
    }
    return count;
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
    expect(await previewVertices(page)).toBe(0);

    await page.mouse.move(...seed);
    // 静止 200ms から検出まで、初回は撮影のぶん少し待つ。
    await expect.poll(() => previewVertices(page), { timeout: 20_000 }).toBeGreaterThan(100);

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
    await expect.poll(() => previewVertices(page), { timeout: 20_000 }).toBeGreaterThan(100);

    await page.mouse.move(900, 400);
    await page.mouse.down();
    await page.mouse.move(700, 500, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    // 動かしたあとの輪郭は、もう写真と合っていない。
    expect(await itemRows(page)).toHaveLength(0);
  });

  test('道具を離れると下見も止まる', async ({ page }) => {
    await page.mouse.move(...PADDY_SEEDS[1]!);
    await expect.poll(() => previewVertices(page), { timeout: 20_000 }).toBeGreaterThan(100);

    await setTool(page, 'manual');
    await page.waitForTimeout(400);
    expect(await previewVertices(page)).toBe(0);
  });
});
