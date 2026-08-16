import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectErrors,
  dragMap,
  drawPolygon,
  EDIT_HINT,
  hint,
  openApp,
  paddyRows,
  startNew,
} from './helpers';

const FIRST: [number, number][] = [
  [300, 250],
  [500, 250],
  [500, 400],
  [300, 400],
];
const SECOND: [number, number][] = [
  [700, 450],
  [900, 450],
  [900, 620],
  [700, 620],
];

/** 削除は確認を挟む。ハンドラを常設すると startNew の分と二重に応答するので、都度張る。 */
function acceptNextDialog(page: import('@playwright/test').Page): void {
  page.once('dialog', (dialog) => void dialog.accept());
}

test.describe('複数の田んぼを持ち回る', () => {
  let errors: string[];
  let work: string;

  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page);
    work = mkdtempSync(join(tmpdir(), 'tanbo-'));
    await openApp(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('輪郭を閉じると一覧に保存され、再読み込みしても残る', async ({ page }) => {
    await expect(page.locator('#library-empty')).toBeVisible();
    await expect(page.locator('#export')).toBeDisabled();

    await drawPolygon(page, FIRST);
    let rows = await paddyRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.active).toBe(true);
    await expect(page.locator('#export')).toBeEnabled();

    await startNew(page);
    await drawPolygon(page, SECOND);
    rows = await paddyRows(page);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).not.toBe(rows[1]?.name);
    expect(rows.filter((row) => row.active)).toHaveLength(1);
    const areas = rows.map((row) => row.area);

    // 書き出しは遅らせてあるので、閉じる前に落ち着くのを待つ。
    await page.waitForTimeout(700);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="auto"]')).toBeEnabled({ timeout: 60_000 });

    rows = await paddyRows(page);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.area)).toEqual(areas);
    expect(rows.every((row) => !row.active)).toBe(true);
  });

  test('一覧から選ぶと編集に入り、面積も追従する', async ({ page }) => {
    await drawPolygon(page, FIRST);
    await startNew(page);
    await drawPolygon(page, SECOND);

    // 描いた直後は視点が動いていないので、角の座標がそのまま使える。
    const before = (await paddyRows(page))[1]?.area;
    await dragMap(page, [700, 450], [640, 390]);
    expect((await paddyRows(page))[1]?.area).not.toBe(before);
    await dragMap(page, [640, 390], [700, 450]);
    expect((await paddyRows(page))[1]?.area).toBe(before);

    await page.locator('#paddies li:first-child .paddy-select').click();
    await page.waitForTimeout(700);
    expect((await paddyRows(page))[0]?.active).toBe(true);
    await expect(hint(page)).toHaveText(EDIT_HINT);
  });

  test('GeoJSON を書き出して読み込める', async ({ page }) => {
    await drawPolygon(page, FIRST);
    await startNew(page);
    await drawPolygon(page, SECOND);

    const download = page.waitForEvent('download');
    await page.locator('#export').click();
    const file = join(work, 'tanbo.geojson');
    await (await download).saveAs(file);

    const exported = JSON.parse(readFileSync(file, 'utf8'));
    expect(exported.type).toBe('FeatureCollection');
    expect(exported.features).toHaveLength(2);
    for (const feature of exported.features) {
      const ring = feature.geometry.coordinates[0];
      // リングは閉じていること。
      expect(ring.at(0)).toEqual(ring.at(-1));
      // RFC 7946 の外周は反時計回り。
      let doubleArea = 0;
      for (let i = 0; i < ring.length - 1; i += 1) {
        doubleArea += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
      }
      expect(doubleArea).toBeLessThan(0);
      expect(typeof feature.properties.name).toBe('string');
      expect(feature.properties.areaSquareMeters).toBeGreaterThan(0);
    }

    acceptNextDialog(page);
    await page.locator('#paddies li:first-child .paddy-delete').click();
    await page.waitForTimeout(300);
    expect(await paddyRows(page)).toHaveLength(1);

    await page.setInputFiles('#import-file', file);
    await page.waitForTimeout(600);
    expect(await paddyRows(page)).toHaveLength(3);
  });

  test('同じファイルを 2 回読んでも独立した 1 枚として扱う', async ({ page }) => {
    await drawPolygon(page, FIRST);

    const download = page.waitForEvent('download');
    await page.locator('#export').click();
    const file = join(work, 'tanbo.geojson');
    await (await download).saveAs(file);

    await page.setInputFiles('#import-file', file);
    await page.waitForTimeout(600);
    await page.setInputFiles('#import-file', file);
    await page.waitForTimeout(600);

    const rows = await paddyRows(page);
    expect(rows).toHaveLength(3);
    // id が重なっていると、1 枚消したつもりで同じ id の別の枚まで消える。
    expect(new Set(rows.map((row) => row.name)).size).toBe(3);

    acceptNextDialog(page);
    await page.locator('#paddies li:last-child .paddy-delete').click();
    await page.waitForTimeout(300);
    expect(await paddyRows(page)).toHaveLength(2);
  });

  test('交差した輪郭は一覧でも書き出しでも面積を出さない', async ({ page }) => {
    await drawPolygon(page, [
      [400, 250],
      [800, 250],
      [800, 650],
      [400, 650],
    ]);
    await dragMap(page, [400, 250], [820, 640]);

    expect((await paddyRows(page)).at(-1)?.area).toBe('輪郭が交差');

    const download = page.waitForEvent('download');
    await page.locator('#export').click();
    const file = join(work, 'bowtie.geojson');
    await (await download).saveAs(file);

    const exported = JSON.parse(readFileSync(file, 'utf8'));
    const crossed = exported.features.find(
      (feature: { properties: { selfIntersecting: boolean } }) =>
        feature.properties.selfIntersecting
    );
    expect(crossed).toBeDefined();
    expect(crossed.properties.areaSquareMeters).toBeNull();
  });

  test('削除は確認を挟み、取り消せる', async ({ page }) => {
    await drawPolygon(page, FIRST);

    page.once('dialog', (dialog) => void dialog.dismiss());
    await page.locator('#paddies li:first-child .paddy-delete').click();
    await page.waitForTimeout(300);
    expect(await paddyRows(page)).toHaveLength(1);

    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('#paddies li:first-child .paddy-delete').click();
    await page.waitForTimeout(300);
    expect(await paddyRows(page)).toHaveLength(0);
  });

  test('壊れた GeoJSON は黙って飲み込まない', async ({ page }) => {
    const broken = join(work, 'broken.geojson');
    writeFileSync(broken, '{ not json');
    await page.setInputFiles('#import-file', broken);
    await page.waitForTimeout(400);
    await expect(hint(page)).toContainText('読めませんでした');
    expect(await paddyRows(page)).toHaveLength(0);

    const noPolygon = join(work, 'point.geojson');
    writeFileSync(
      noPolygon,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [139, 37] }, properties: {} },
        ],
      })
    );
    await page.setInputFiles('#import-file', noPolygon);
    await page.waitForTimeout(400);
    await expect(hint(page)).toContainText('取り込める');
  });

  test('MultiPolygon は 1 枚ずつに割って取り込む', async ({ page }) => {
    const multi = join(work, 'multi.geojson');
    writeFileSync(
      multi,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'MultiPolygon',
              coordinates: [
                [
                  [
                    [138.7, 37.05],
                    [138.701, 37.05],
                    [138.701, 37.051],
                    [138.7, 37.05],
                  ],
                ],
                [
                  [
                    [138.703, 37.053],
                    [138.704, 37.053],
                    [138.704, 37.054],
                    [138.703, 37.053],
                  ],
                ],
              ],
            },
            properties: { name: 'マルチ' },
          },
        ],
      })
    );

    await page.setInputFiles('#import-file', multi);
    await page.waitForTimeout(600);
    expect(await paddyRows(page)).toHaveLength(2);
  });
});
