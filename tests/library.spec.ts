import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeSettings,
  collectErrors,
  dragMap,
  drawPolygon,
  EDIT_HINT,
  exportGeoJSON,
  hint,
  openApp,
  openSettings,
  startEditing,
  itemRows,
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
    await startEditing(page);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('輪郭を閉じると一覧に保存され、再読み込みしても残る', async ({ page }) => {
    await expect(page.locator('#items-empty')).toBeVisible();
    await openSettings(page);
    await expect(page.locator('#export')).toBeDisabled();
    await closeSettings(page);

    await drawPolygon(page, FIRST);
    let rows = await itemRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.selected).toBe(true);
    await openSettings(page);
    await expect(page.locator('#export')).toBeEnabled();
    await closeSettings(page);

    await startNew(page);
    await drawPolygon(page, SECOND);
    rows = await itemRows(page);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).not.toBe(rows[1]?.name);
    expect(rows.filter((row) => row.selected)).toHaveLength(1);
    const areas = rows.map((row) => row.value);

    // 書き出しは遅らせてあるので、閉じる前に落ち着くのを待つ。
    await page.waitForTimeout(700);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });

    rows = await itemRows(page);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.value)).toEqual(areas);
    expect(rows.every((row) => !row.selected)).toBe(true);
  });

  test('一覧から選ぶと編集に入り、面積も追従する', async ({ page }) => {
    await drawPolygon(page, FIRST);
    await startNew(page);
    await drawPolygon(page, SECOND);

    // 描いた直後は視点が動いていないので、角の座標がそのまま使える。
    const before = (await itemRows(page))[1]?.value;
    await dragMap(page, [700, 450], [640, 390]);
    expect((await itemRows(page))[1]?.value).not.toBe(before);
    await dragMap(page, [640, 390], [700, 450]);
    expect((await itemRows(page))[1]?.value).toBe(before);

    await page.locator('#items li:first-child .item-select').click();
    await page.waitForTimeout(700);
    expect((await itemRows(page))[0]?.selected).toBe(true);
    await expect(hint(page)).toHaveText(EDIT_HINT);
  });

  test('GeoJSON を書き出して読み込める', async ({ page }) => {
    await drawPolygon(page, FIRST);
    await startNew(page);
    await drawPolygon(page, SECOND);

    const file = join(work, 'tanbo.geojson');
    await exportGeoJSON(page, file);

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
    await page.locator('#items li:first-child .item-delete').click();
    await page.waitForTimeout(300);
    expect(await itemRows(page)).toHaveLength(1);

    await page.setInputFiles('#import-file', file);
    await page.waitForTimeout(600);
    expect(await itemRows(page)).toHaveLength(3);
  });

  test('同じファイルを 2 回読んでも独立した 1 枚として扱う', async ({ page }) => {
    await drawPolygon(page, FIRST);

    const file = join(work, 'tanbo.geojson');
    await exportGeoJSON(page, file);

    await page.setInputFiles('#import-file', file);
    await page.waitForTimeout(600);
    await page.setInputFiles('#import-file', file);
    await page.waitForTimeout(600);

    const rows = await itemRows(page);
    expect(rows).toHaveLength(3);
    // id が重なっていると、1 枚消したつもりで同じ id の別の枚まで消える。
    expect(new Set(rows.map((row) => row.name)).size).toBe(3);

    acceptNextDialog(page);
    await page.locator('#items li:last-child .item-delete').click();
    await page.waitForTimeout(300);
    expect(await itemRows(page)).toHaveLength(2);
  });

  test('交差した輪郭は一覧でも書き出しでも面積を出さない', async ({ page }) => {
    await drawPolygon(page, [
      [400, 250],
      [800, 250],
      [800, 650],
      [400, 650],
    ]);
    await dragMap(page, [400, 250], [820, 640]);

    expect((await itemRows(page)).at(-1)?.value).toBe('輪郭が交差');

    const file = join(work, 'bowtie.geojson');
    await exportGeoJSON(page, file);

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
    await page.locator('#items li:first-child .item-delete').click();
    await page.waitForTimeout(300);
    expect(await itemRows(page)).toHaveLength(1);

    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('#items li:first-child .item-delete').click();
    await page.waitForTimeout(300);
    expect(await itemRows(page)).toHaveLength(0);
  });

  test('壊れた GeoJSON は黙って飲み込まない', async ({ page }) => {
    const broken = join(work, 'broken.geojson');
    writeFileSync(broken, '{ not json');
    await page.setInputFiles('#import-file', broken);
    await page.waitForTimeout(400);
    await expect(hint(page)).toContainText('読めませんでした');
    expect(await itemRows(page)).toHaveLength(0);

    // 点は「取り込めないもの」ではなくピンになる。形として読めないものだけを弾く。
    const unusable = join(work, 'unusable.geojson');
    writeFileSync(
      unusable,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'GeometryCollection', geometries: [] }, properties: {} },
        ],
      })
    );
    await page.setInputFiles('#import-file', unusable);
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
    expect(await itemRows(page)).toHaveLength(2);
  });
});
