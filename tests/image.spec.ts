import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clickMap,
  collectErrors,
  drawPolygon,
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

/** PNG の幅と高さ。IHDR は必ず先頭にあり、16 バイト目から 4 バイトずつ入っている。 */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test.describe('見えているところを画像にする', () => {
  let errors: string[];
  let work: string;

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    work = mkdtempSync(join(tmpdir(), 'tanbo-image-'));
    await openApp(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('表示モードでだけ出す', async ({ page }) => {
    await expect(page.locator('#image-open')).toBeVisible();
    await setMode(page, 'edit');
    // 編集の道具と場所を取り合わせない。
    await expect(page.locator('#image-open')).toBeHidden();
    await setMode(page, 'view');
    await expect(page.locator('#image-open')).toBeVisible();
  });

  test('選んだ比率の枠が出る', async ({ page }) => {
    await page.locator('#image-open').click();
    await page.waitForTimeout(300);

    const square = (await page.locator('#crop-frame').boundingBox())!;
    expect(Math.abs(square.width - square.height)).toBeLessThan(2);

    await page.locator('#crop-ratios label:has(#crop-ratio-4\\:3)').click();
    await page.waitForTimeout(200);
    const wide = (await page.locator('#crop-frame').boundingBox())!;
    expect(wide.width / wide.height).toBeCloseTo(4 / 3, 1);

    await page.locator('#crop-ratios label:has(#crop-ratio-3\\:4)').click();
    await page.waitForTimeout(200);
    const tall = (await page.locator('#crop-frame').boundingBox())!;
    expect(tall.width / tall.height).toBeCloseTo(3 / 4, 1);
  });

  test('枠の大きさを変えられ、やめると閉じる', async ({ page }) => {
    await page.locator('#image-open').click();
    await page.waitForTimeout(300);
    const before = (await page.locator('#crop-frame').boundingBox())!;

    await page.locator('#crop-size').fill('40');
    await page.waitForTimeout(200);
    const after = (await page.locator('#crop-frame').boundingBox())!;
    expect(after.width).toBeLessThan(before.width);

    await page.locator('#crop-cancel').click();
    await page.waitForTimeout(200);
    await expect(page.locator('#crop-bar')).toBeHidden();
    await expect(page.locator('#image-open')).toBeVisible();
  });

  test('PNG が落ちてきて、比率も選んだとおり', async ({ page }) => {
    await startEditing(page);
    await drawPolygon(page, SQUARE);
    await setMode(page, 'view');
    await page.waitForTimeout(400);

    await page.locator('#image-open').click();
    await page.locator('#crop-ratios label:has(#crop-ratio-4\\:3)').click();
    await page.waitForTimeout(300);

    const download = page.waitForEvent('download');
    await page.locator('#crop-run').click();
    const saved = await download;
    expect(saved.suggestedFilename()).toMatch(/^tanbo-\d{8}-\d{4}\.png$/);

    const file = join(work, 'shot.png');
    await saved.saveAs(file);
    const { width, height } = pngSize(file);
    expect(width / height).toBeCloseTo(4 / 3, 1);
    // 画面の見えかたそのままの解像度。小さすぎると使いものにならない。
    expect(width).toBeGreaterThan(400);
  });

  test('JPEG でも落とせる', async ({ page }) => {
    await page.locator('#image-open').click();
    await page.locator('#crop-formats label:has(#crop-format-jpeg)').click();
    await page.waitForTimeout(300);

    const download = page.waitForEvent('download');
    await page.locator('#crop-run').click();
    const saved = await download;
    expect(saved.suggestedFilename()).toMatch(/\.jpg$/);

    const file = join(work, 'shot.jpg');
    await saved.saveAs(file);
    const bytes = readFileSync(file);
    // JPEG の始まりは FF D8。透明を黒く塗らないよう、下地は白で埋めてある。
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  });

  test('回したまま書き出すと、回った絵で出てくる', async ({ page }) => {
    // 表示モードは回せる。画面の canvas をそのまま切るので、向きも一緒に写る。
    await page.mouse.move(800, 400);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(950, 400, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(400);
    const bearing = await page.evaluate(() =>
      (window as unknown as { __tanboMap: { getBearing(): number } }).__tanboMap.getBearing()
    );
    expect(Math.abs(bearing)).toBeGreaterThan(5);

    await page.locator('#image-open').click();
    await page.waitForTimeout(300);
    const download = page.waitForEvent('download');
    await page.locator('#crop-run').click();
    const file = join(work, 'rotated.png');
    await (await download).saveAs(file);

    // 縮尺の帯や道の向きまでは見ないが、画は出ている（真っ白なら切り出しが失敗している）。
    const { width, height } = pngSize(file);
    expect(width).toBeGreaterThan(400);
    expect(height).toBeGreaterThan(400);
  });

  test('ピンと計測のラベルも画像に入る', async ({ page }) => {
    await startEditing(page, 'pin');
    await clickMap(page, 700, 350);
    await startNew(page, 'measure');
    await clickMap(page, 600, 450);
    await clickMap(page, 850, 500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await setMode(page, 'view');
    await page.waitForTimeout(500);

    await page.locator('#image-open').click();
    await page.waitForTimeout(300);
    const download = page.waitForEvent('download');
    await page.locator('#crop-run').click();
    const file = join(work, 'marks.png');
    await (await download).saveAs(file);

    // ピンの白い丸とラベルの黒い地は、写真には出ない濃さで出る。画素で数える。
    const counted = await page.evaluate(async (dataUrl) => {
      const image = new Image();
      await new Promise((resolve) => {
        image.onload = resolve;
        image.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let white = 0;
      let dark = 0;
      for (let at = 0; at < data.length; at += 4) {
        const [red, green, blue] = [data[at]!, data[at + 1]!, data[at + 2]!];
        if (red > 245 && green > 245 && blue > 245) white += 1;
        if (red < 45 && green < 45 && blue < 45) dark += 1;
      }
      return { white, dark };
    }, `data:image/png;base64,${readFileSync(file).toString('base64')}`);

    expect(counted.white).toBeGreaterThan(200);
    expect(counted.dark).toBeGreaterThan(200);
  });
});
