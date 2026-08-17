import { expect, test } from '@playwright/test';
import { mapPixels, openApp, waitForApp } from './helpers';

/**
 * 電波の届かない田んぼで開くための確認。
 *
 * ためた写真から地図が出ることを、パネルの表示ではなく地図の画で見る。
 * 「保存しました」と出ているのに現地では真っ白、が一番まずい壊れ方なので。
 */
/** 透明な 1px の PNG。中身を問わないタイル要求の差し替えに使う。 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test.describe('オフラインで使う', () => {
  // 通信を切ったまま開き直せるのは、ファイルから開く単一 HTML だけ。dev / preview は
  // ページ自体がサーバから来るので、この確認は standalone のときだけ意味を持つ。
  test('表示中の範囲を保存すると、通信を切っても写真が出る', async ({ page, context }) => {
    test.skip(process.env['TANBO_TEST_STANDALONE'] !== '1', '単一 HTML でだけ確かめられる');
    await openApp(page);
    page.on('dialog', (dialog) => void dialog.accept());
    // 通信を切ったあとに 1 本でも取りに行っていれば、ためたつもりのものが足りていない。
    // 画が出ているかだけを見ると、maplibre が粗いタイルで埋めた場合を見逃す。
    const missed: string[] = [];

    await page.locator('#offline-save').click();
    await expect(page.locator('#offline-status')).toContainText('保存しました', {
      timeout: 180_000,
    });

    await context.setOffline(true);
    page.on('requestfailed', (request) => missed.push(request.url()));
    await page.reload({ waitUntil: 'load' });
    await waitForApp(page, 3000);

    // 写真が出ていれば、地図はほぼ塗りつぶされる。出ていなければ下地の色だけになる。
    expect(await mapPixels(page, 'covered')).toBeGreaterThan(0.5);
    expect(missed).toEqual([]);
    await expect(page.locator('#offline-status')).toContainText('枚');
  });

  test('保存したものは消せる', async ({ page }) => {
    // 消せるかどうかは保存領域の話で、写真の中身は関係ない。公共のタイルサーバから
    // 何百枚も落とさずに済むよう、ここでは 1px の画像で代える。
    await page.route(/cyberjapandata\.gsi\.go\.jp|geogeo\.blob\.core\.windows\.net/, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    );
    await openApp(page);
    page.on('dialog', (dialog) => void dialog.accept());

    await page.locator('#offline-save').click();
    await expect(page.locator('#offline-status')).toContainText('保存しました', {
      timeout: 180_000,
    });

    await page.locator('#offline-clear').click();
    await expect(page.locator('#offline-status')).toHaveText('まだ保存していません');
    await expect(page.locator('#offline-clear')).toBeDisabled();
  });
});
