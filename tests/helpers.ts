import { expect, type Page } from '@playwright/test';

/** `TANBO_TEST_STANDALONE=1` のときに開く、単一 HTML の file:// URL。 */
const standaloneURL =
  process.env['TANBO_TEST_STANDALONE'] === '1'
    ? new URL('../dist-standalone/index.html', import.meta.url).href
    : null;

/** 既定表示（十日町市）で確実に圃場の中心に落ちるシード。view-1x の画から拾った。 */
export const PADDY_SEEDS: [x: number, y: number][] = [
  [505, 200],
  [555, 315],
  [390, 330],
  [150, 470],
  [110, 590],
  [1075, 300],
  [960, 400],
];

/** 圃場がない斜面。塗りが成立せず、検出が失敗する側の確認に使う。 */
export const NO_FIELD_SEED: [x: number, y: number] = [900, 600];

export const EDIT_HINT = '頂点をドラッグで移動、中点をクリックで追加。削除は右クリック、または選択して Delete';
export const EDIT_HINT_MIN = '頂点をドラッグで移動、中点をクリックで追加（これ以上は減らせません）';

/** 地図のスタイルが揃い、パネルが操作できるようになるまで待つ。 */
export async function openApp(page: Page, query = ''): Promise<void> {
  await page.goto(standaloneURL === null ? `/${query}` : `${standaloneURL}${query}`, {
    waitUntil: 'networkidle',
  });
  await waitForApp(page);
}

/**
 * パネルが操作できるようになり、タイルが出そろうまで待つ。
 *
 * 開き直したあとにも要るので、`openApp` と分けてある。自動検出は表示中の画像を読むため、
 * 用意ができた合図だけでは足りず、描画が落ち着くまで少し待つ。
 */
export async function waitForApp(page: Page, settleMs = 2000): Promise<void> {
  await expect(page.locator('#mode input[value="auto"]')).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(settleMs);
}

export async function clickMap(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y);
  await page.waitForTimeout(120);
}

export async function dragMap(
  page: Page,
  from: [number, number],
  to: [number, number]
): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.waitForTimeout(80);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/** 頂点を順に置いて Enter で閉じる。 */
export async function drawPolygon(page: Page, points: [number, number][]): Promise<void> {
  for (const [x, y] of points) await clickMap(page, x, y);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
}

export function hint(page: Page) {
  return page.locator('#hint');
}

/** 表示中の面積（㎡）。出ていなければ null。 */
export async function areaSquareMeters(page: Page): Promise<number | null> {
  if (await page.locator('#area').isHidden()) return null;
  return Number((await page.locator('#area-square-meters').innerText()).replace(/,/g, ''));
}

/** 自動検出モードに入り、1 点クリックして結果が出るまで待つ。かかった時間を返す。 */
export async function detectAt(page: Page, x: number, y: number): Promise<number> {
  // 検出に失敗すると自動検出モードのままなので、必要なときだけ切り替える。
  const auto = page.locator('#mode input[value="auto"]');
  if (!(await auto.isChecked())) {
    // radio は視覚的に隠してあるので、ラベルを押す。
    await page.locator('#mode label:has(input[value="auto"])').click();
    await expect(hint(page)).toHaveText('田んぼの中をクリックすると輪郭を推定します');
  }

  const started = Date.now();
  await page.mouse.click(x, y);
  await expect(hint(page)).not.toHaveText('検出中…', { timeout: 150_000 });
  return Date.now() - started;
}

/** 描いたものを捨てて次に進む。「新しく描く」は確認を挟まない。 */
export async function startNew(page: Page): Promise<void> {
  const reset = page.locator('#reset');
  if (await reset.isEnabled()) await reset.click();
  await page.waitForTimeout(200);
}

/** 一覧の各行。 */
export async function paddyRows(
  page: Page
): Promise<{ name: string; area: string; active: boolean }[]> {
  return page.$$eval('#paddies li', (items) =>
    items.map((li) => ({
      name: li.querySelector('.paddy-select span')?.textContent ?? '',
      area: li.querySelector('.paddy-area')?.textContent ?? '',
      active: li.classList.contains('active'),
    }))
  );
}

/** 画素を数えるときの見方。編集中の色（#00b0ff）か、何か描かれているか。 */
type PixelKind = 'drawn' | 'covered';

/**
 * 地図の canvas の画素を数える。
 *
 * 面積は出ているのに地図には何も出ない、という壊れ方があるので、数値ではなく画を見る。
 * `drawn` は編集中の色に一致した画素数。航空写真にも青い屋根が写るため、絶対数ではなく
 * 描く前後の差で判断する。`covered` は何か描かれている画素の割合（0〜1）で、写真タイルが
 * 出ていれば地図はほぼ埋まり、出ていなければ透明のまま残る。
 */
export async function mapPixels(page: Page, kind: PixelKind): Promise<number> {
  return page.evaluate((target: PixelKind) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#map canvas');
    if (canvas === null) throw new Error('地図の canvas が見つかりません');
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d');
    if (context === null) throw new Error('2D コンテキストを作れません');
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);

    let matched = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [red, green, blue, alpha] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
      const hit =
        target === 'drawn'
          ? red < 70 && green > 140 && green < 205 && blue > 215
          : alpha > 10;
      if (hit) matched += 1;
    }
    return target === 'covered' ? matched / (copy.width * copy.height) : matched;
  }, kind);
}

/** console と pageerror を集める。テストの最後に空であることを確かめる。 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)));
  return errors;
}
