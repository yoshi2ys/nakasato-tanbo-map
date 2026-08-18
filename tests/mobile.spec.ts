import { devices, expect, test, type Page } from '@playwright/test';
import { collectErrors, itemRows, openApp, openSettings } from './helpers';

/**
 * 電話で開いたときの画面。
 *
 * 列を並べる幅がないので、一覧も選んだものの情報も下から出るシートになる。
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

  test('設定は地図の上のボタンから開ける', async ({ page }) => {
    // 一覧を開かないと設定に入れない、では文字を大きくしたい人に遠すぎる。
    await expect(page.locator('#settings-open-map')).toBeVisible();
    await openSettings(page);
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#text-ui-medium')).toBeChecked();
  });

  test('道具は記号と名前の両方を出す', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);

    const tool = page.locator('#tools label').first();
    await expect(tool.locator('svg')).toBeVisible();
    await expect(tool).toContainText('手動範囲');
  });

  test('タップで田んぼを描け、情報が下から出る', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);

    for (const [x, y] of TRIANGLE) await tapMap(page, x, y);
    await page.locator('#finish-draw').tap();
    await page.waitForTimeout(500);

    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('paddy');

    // 選んでいるあいだは情報が地図の下から出る。右上に浮かべると地図が塞がる。
    const panel = (await page.locator('#panel').boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(panel.y).toBeLessThan(viewport.height);
    expect(panel.y).toBeGreaterThan(viewport.height / 2);
    await expect(page.locator('#panel')).toBeVisible();
  });

  test('指だけで計測を終えられる', async ({ page }) => {
    // ダブルタップも Enter も使えない。確定はボタンで受ける。
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.locator('#tools label:has(input[value="measure"])').tap();
    await page.waitForTimeout(300);

    await expect(page.locator('#finish-draw')).toBeHidden();
    await tapMap(page, 110, 320);
    // 1 点では終われないので、まだ出さない。
    await expect(page.locator('#finish-draw')).toBeHidden();

    await tapMap(page, 280, 320);
    await expect(page.locator('#finish-draw')).toBeVisible();
    await page.locator('#finish-draw').tap();
    await page.waitForTimeout(400);

    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('measure');
    await expect(page.locator('#finish-draw')).toBeHidden();
  });

  test('指だけで田んぼを閉じられる', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);

    for (const [x, y] of TRIANGLE) await tapMap(page, x, y);
    await expect(page.locator('#finish-draw')).toBeVisible();
    await page.locator('#finish-draw').tap();
    await page.waitForTimeout(400);

    const rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('paddy');
  });

  test('指だけで描きかけをやめられる', async ({ page }) => {
    // Esc が押せないので、取りやめもボタンで受ける。
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);

    await expect(page.locator('#discard-draw')).toBeHidden();
    await tapMap(page, 110, 300);
    await expect(page.locator('#discard-draw')).toBeVisible();

    await page.locator('#discard-draw').tap();
    await page.waitForTimeout(300);
    await expect(page.locator('#discard-draw')).toBeHidden();
    expect(await itemRows(page)).toHaveLength(0);
  });

  test('指だけで頂点を削除できる', async ({ page }) => {
    // 右クリックも Delete も使えないので、選んでからボタンで消す。
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);
    for (const [x, y] of [...TRIANGLE, [110, 430] as [number, number]]) await tapMap(page, x, y);
    await page.locator('#finish-draw').tap();
    await page.waitForTimeout(400);

    // 頂点を選ぶまではボタンを出さない。
    await expect(page.locator('#delete-vertex')).toBeHidden();
    await tapMap(page, 110, 300);
    await expect(page.locator('#delete-vertex')).toBeVisible();

    const before = (await itemRows(page))[0]?.value;
    await page.locator('#delete-vertex').tap();
    await page.waitForTimeout(400);

    expect((await itemRows(page))[0]?.value).not.toBe(before);
    // 3 頂点まで減ったら、それ以上は消せないのでボタンも消える。
    await expect(page.locator('#delete-vertex')).toBeHidden();
  });

  test('計測の点も指で動かせる', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.locator('#tools label:has(input[value="measure"])').tap();
    await page.waitForTimeout(300);

    await tapMap(page, 110, 320);
    await tapMap(page, 280, 320);
    await page.locator('#finish-draw').tap();
    await page.waitForTimeout(400);

    const before = (await itemRows(page))[0]?.value;
    await touchDrag(page, [280, 320], [280, 460]);

    expect((await itemRows(page))[0]?.value).not.toBe(before);
  });

  test('指で頂点を動かせる', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);
    for (const [x, y] of TRIANGLE) await tapMap(page, x, y);
    await page.locator('#finish-draw').tap();
    await page.waitForTimeout(400);

    const before = (await itemRows(page))[0]?.value;
    // 横に動かす。縦に動かすと、この三角形は底辺も高さも変わらず面積が同じままになる。
    await touchDrag(page, TRIANGLE[0]!, [210, 300]);

    expect((await itemRows(page))[0]?.value).not.toBe(before);
  });
  test('指で押すものは 44px 角を下回らない', async ({ page }) => {
    // HIG の最小の的。狭い画面ではここを切ると、隣を押してしまう。
    const atLeast44 = async (selector: string): Promise<void> => {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box.width, selector).toBeGreaterThanOrEqual(44);
      expect(box.height, selector).toBeGreaterThanOrEqual(44);
    };

    for (const selector of ['#list-open', '#settings-open-map']) await atLeast44(selector);

    await page.locator('#list-open').tap();
    await page.waitForTimeout(400);
    for (const selector of [
      '#list-close',
      '#settings-open',
      '#item-search',
      '#kind-filters label',
    ]) {
      await atLeast44(selector);
    }

    await page.locator('#list-close').tap();
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);
    for (const selector of ['#mode label', '#tools label']) await atLeast44(selector);

    // 描いている最中のボタン。指しか使えない端末では、これが唯一の手段になる。
    await tapMap(page, TRIANGLE[0]![0], TRIANGLE[0]![1]);
    await atLeast44('#discard-draw');
    for (const [x, y] of TRIANGLE.slice(1)) await tapMap(page, x, y);
    await atLeast44('#finish-draw');
    await page.locator('#finish-draw').tap();
    await page.waitForTimeout(500);

    // パネルと、その先の詳細シート。
    for (const selector of ['#panel-detail', '#panel-close']) await atLeast44(selector);
    await page.locator('#panel-detail').tap();
    await page.waitForTimeout(400);
    for (const selector of ['#detail-close', '#detail-name', '.swatch', '#detail-delete']) {
      await atLeast44(selector);
    }
    await page.locator('#detail-close').tap();
    await page.waitForTimeout(300);

    // 「編集」は編集器に載っていないときだけ出る。表示に戻してから測る。
    await page.locator('#mode label:has(input[value="view"])').tap();
    await page.waitForTimeout(300);
    await atLeast44('#panel-edit');
  });

  test('狭い画面では、編集中でも欄はシートの中', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.waitForTimeout(300);
    for (const [x, y] of TRIANGLE) await tapMap(page, x, y);
    await page.locator('#finish-draw').tap();
    await page.waitForTimeout(500);

    // 右上に浮かべる余裕がないので、パネルは読むだけに留める。
    await expect(page.locator('#panel-fields')).toBeHidden();
    await expect(page.locator('#panel-detail')).toBeVisible();

    await page.locator('#panel-detail').tap();
    await page.waitForTimeout(400);
    await expect(page.locator('#detail-sheet #detail-name')).toBeVisible();
  });

  test('ピンのアイコンも指の寸法で選べる', async ({ page }) => {
    await page.locator('#mode label:has(input[value="edit"])').tap();
    await page.locator('#tools label:has(input[value="pin"])').tap();
    await page.waitForTimeout(300);
    await tapMap(page, 200, 300);
    await page.waitForTimeout(400);

    await page.locator('#panel-detail').tap();
    await page.waitForTimeout(400);
    const box = (await page.locator('.icon-choice').first().boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});
