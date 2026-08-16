import { expect, test } from '@playwright/test';
import {
  areaSquareMeters,
  collectErrors,
  detectAt,
  EDIT_HINT,
  NO_FIELD_SEED,
  hint,
  openApp,
  PADDY_SEEDS,
  paddyRows,
  startNew,
} from './helpers';

/** 十日町の棚田 1 枚として妥当な広さ（おおむね 1〜10 畝）。これを外れたら塗りが漏れている。 */
const MIN_PLOT = 100;
const MAX_PLOT = 6000;

test.describe('シード 1 点からの自動検出', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    await openApp(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('十日町市の航空写真が出典付きで使われている', async ({ page }) => {
    const attribution = page.locator('.maplibregl-ctrl-attrib-inner');
    await expect(attribution).toContainText('十日町市');
    await expect(attribution).toContainText('国土地理院');
  });

  test('1 クリックで棚田の輪郭が取れ、そのまま編集できる', async ({ page }) => {
    const elapsed = await detectAt(page, ...PADDY_SEEDS[1]!);
    // 初回は OpenCV.js の 13MB 読み込みを含む。
    expect(elapsed).toBeLessThan(120_000);

    const detected = await areaSquareMeters(page);
    expect(detected).toBeGreaterThan(MIN_PLOT);
    expect(detected).toBeLessThan(MAX_PLOT);

    // 検出後は手動（編集）に戻る。頂点編集そのものは edit.spec.ts が見ている。
    await expect(hint(page)).toHaveText(EDIT_HINT);
    // 下書きとして一覧にも入り、あとから選び直せる。
    const rows = await paddyRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.active).toBe(true);
    expect(Number(rows[0]!.area.replace(/[^0-9]/g, ''))).toBe(detected);
  });

  test('複数の圃場を続けて検出でき、2 回目からは速い', async ({ page }) => {
    await detectAt(page, ...PADDY_SEEDS[1]!);

    const areas: number[] = [];
    let slowest = 0;
    for (const seed of PADDY_SEEDS) {
      await startNew(page);
      const elapsed = await detectAt(page, ...seed);
      slowest = Math.max(slowest, elapsed);
      const area = await areaSquareMeters(page);
      if (area !== null) areas.push(area);
    }

    // 7 点のうち大半が取れること。すべてを求めると畦の写り方に左右されて脆くなる。
    expect(areas.length).toBeGreaterThanOrEqual(5);
    // OpenCV は読み込み済みなので、2 回目以降は待たされない。
    expect(slowest).toBeLessThan(20_000);
    // Mat を解放し損ねていると、繰り返すうちに面積が壊れるか例外になる。
    for (const area of areas) {
      expect(area).toBeGreaterThan(MIN_PLOT);
      expect(area).toBeLessThan(MAX_PLOT);
    }
  });

  test('検出できない場所は理由を出して黙って通さない', async ({ page }) => {
    await detectAt(page, ...NO_FIELD_SEED);

    await expect(page.locator('#area')).toBeHidden();
    await expect(hint(page)).toHaveClass(/warning/);
    await expect(hint(page)).toContainText(/見つけられません|小さすぎ|越えて/);
  });

  test('メジャーで引いた線が検出の邪魔をしない', async ({ page }) => {
    // 計測の線は写真の上に描かれる。撮影に写り込むとフラッドフィルの壁になる。
    await page.locator('#mode label:has(input[value="measure"])').click();
    await page.mouse.click(500, 300);
    await page.waitForTimeout(120);
    await page.mouse.click(620, 340);
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    await detectAt(page, ...PADDY_SEEDS[1]!);
    const detected = await areaSquareMeters(page);
    expect(detected).toBeGreaterThan(MIN_PLOT);
    expect(detected).toBeLessThan(MAX_PLOT);
  });

  test('検出中はモードの切り替えを受け付けない', async ({ page }) => {
    await page.locator('#mode label:has(input[value="auto"])').click();
    await page.mouse.click(...PADDY_SEEDS[1]!);
    // 検出が終わる前に見る。
    await page.waitForTimeout(40);
    const lockedWhileRunning = await page.locator('#mode input[value="manual"]').isDisabled();

    await expect(hint(page)).not.toHaveText('検出中…', { timeout: 150_000 });
    expect(lockedWhileRunning).toBe(true);
    await expect(page.locator('#mode input[value="manual"]')).toBeEnabled();
  });
});
