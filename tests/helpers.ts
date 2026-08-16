import { expect, type Page } from '@playwright/test';

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
  await page.goto(`/${query}`, { waitUntil: 'networkidle' });
  await expect(page.locator('#mode input[value="auto"]')).toBeEnabled({ timeout: 60_000 });
  // タイルが出そろってから測る。自動検出は表示中の画像を読むため。
  await page.waitForTimeout(2000);
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

/** console と pageerror を集める。テストの最後に空であることを確かめる。 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)));
  return errors;
}
