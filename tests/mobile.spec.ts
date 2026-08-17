import { devices, expect, test, type Page } from '@playwright/test';
import { collectErrors, itemRows, openApp } from './helpers';

/**
 * 電話で開いたときの画面。
 *
 * 列を 3 つ並べる幅がないので、一覧とインスペクタは下から出るシートになる。
 * 操作はすべて指で、頂点のドラッグも touch のまま届く（maplibre がタップだけ click に直す）。
 */
test.use({ ...devices['iPhone 14 Pro'] });

/** 指でなぞる。Playwright の touchscreen は tap しか持たないので、CDP で送る。 */
async function touchDrag(
  page: Page,
  from: [number, number],
  to: [number, number],
  steps = 8
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, radiusX: 12, radiusY: 12, force: 1 }];

  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: point(from[0], from[1]),
  });
  for (let step = 1; step <= steps; step += 1) {
    const x = from[0] + ((to[0] - from[0]) * step) / steps;
    const y = from[1] + ((to[1] - from[1]) * step) / steps;
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) });
    await page.waitForTimeout(30);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(250);
  await session.detach();
}

async function tapMap(page: Page, x: number, y: number): Promise<void> {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(180);
}

const TRIANGLE: [number, number][] = [
  [110, 300],
  [280, 300],
  [280, 430],
];

test.describe('電話で使う', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('一覧はボタンで開き、閉じられる', async ({ page }) => {
    // 幅が足りないので、一覧は地図に重ならず引っ込んでいる。
    await expect(page.locator('#list-open')).toBeVisible();
    expect(await page.locator('#sidebar').boundingBox()).not.toBeNull();
    const hidden = (await page.locator('#sidebar').boundingBox())!.y;

    await page.locator('#list-open').tap();
    await page.waitForTimeout(400);
    const shown = (await page.locator('#sidebar').boundingBox())!.y;
    expect(shown).toBeLessThan(hidden);

    await page.locator('#list-close').tap();
    await page.waitForTimeout(400);
    expect((await page.locator('#sidebar').boundingBox())!.y).toBeGreaterThan(shown);
  });

  test('道具は記号と名前の両方を出す', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);

    const tool = page.locator('#tools label').first();
    await expect(tool.locator('svg')).toBeVisible();
    await expect(tool).toContainText('手動範囲');
  });

  test('タップで田んぼを描け、インスペクタが下から出る', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);

    for (const [x, y] of TRIANGLE) await tapMap(page, x, y);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('paddy');

    // 選んでいるあいだはインスペクタが地図の下半分に出る。
    const inspector = (await page.locator('#inspector').boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(inspector.y).toBeLessThan(viewport.height);
    await expect(page.locator('#inspector-body')).toBeVisible();
  });

  test('指で頂点を動かせる', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);
    for (const [x, y] of TRIANGLE) await tapMap(page, x, y);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);

    const before = (await itemRows(page))[0]?.value;
    // 横に動かす。縦に動かすと、この三角形は底辺も高さも変わらず面積が同じままになる。
    await touchDrag(page, TRIANGLE[0]!, [210, 300]);

    expect((await itemRows(page))[0]?.value).not.toBe(before);
  });
});
