import { expect, type Page } from '@playwright/test';

/** 地図の左端。左の一覧のぶんだけ、ページ座標は右にずれる。 */
const MAP_LEFT = 260;

/** 既定表示（十日町市）で確実に圃場の中心に落ちるシード。地図の中の位置で持つ。 */
export const PADDY_SEEDS: [x: number, y: number][] = [
  [505, 200],
  [555, 315],
  [390, 330],
  [150, 470],
  [110, 590],
  [1075, 300],
  [960, 400],
].map(([x, y]) => [x! + MAP_LEFT, y!] as [number, number]);

/** 圃場がない斜面。塗りが成立せず、検出が失敗する側の確認に使う。 */
export const NO_FIELD_SEED: [x: number, y: number] = [900 + MAP_LEFT, 600];

export { EDIT_HINT, EDIT_HINT_MIN } from '../src/hints';

/** 編集で使う道具。ツールバーの並びと同じ。 */
export type Tool = 'manual' | 'auto' | 'measure' | 'pin';

/** 地図のスタイルが揃い、パネルが操作できるようになるまで待つ。 */
export async function openApp(page: Page, query = ''): Promise<void> {
  // baseURL は公開先と同じサブパスまで含むので、相対で開く。
  await page.goto(`.${query}`, { waitUntil: 'networkidle' });
  await waitForApp(page);
}

/**
 * パネルが操作できるようになり、タイルが出そろうまで待つ。
 *
 * 開き直したあとにも要るので、`openApp` と分けてある。自動検出は表示中の画像を読むため、
 * 用意ができた合図だけでは足りず、描画が落ち着くまで少し待つ。
 */
export async function waitForApp(page: Page, settleMs = 2000): Promise<void> {
  await expect(page.locator('#mode input[value="edit"]')).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(settleMs);
}

/** 表示と編集を切り替える。 */
export async function setMode(page: Page, mode: 'view' | 'edit'): Promise<void> {
  await page.locator(`#mode label:has(input[value="${mode}"])`).click();
  await page.waitForTimeout(200);
}

/** 編集の道具を選ぶ。すでに選ばれていれば、新しく描き始める合図になる。 */
export async function setTool(page: Page, tool: Tool): Promise<void> {
  await page.locator(`#tools label:has(input[value="${tool}"])`).click();
  await page.waitForTimeout(200);
}

/** 編集モードに入って道具を選ぶ、という前置き。 */
export async function startEditing(page: Page, tool: Tool = 'manual'): Promise<void> {
  await setMode(page, 'edit');
  await setTool(page, tool);
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
  // 検出に失敗しても自動検出のままなので、必要なときだけ切り替える。
  const auto = page.locator('#tools input[value="auto"]');
  if (!(await auto.isChecked())) {
    // radio は視覚的に隠してあるので、ラベルを押す。
    await page.locator('#tools label:has(input[value="auto"])').click();
    await expect(hint(page)).toContainText('カーソルを合わせる');
  }

  const started = Date.now();
  await page.mouse.click(x, y);
  await expect(hint(page)).not.toHaveText('検出中…', { timeout: 150_000 });
  return Date.now() - started;
}

/**
 * いま描いているものを確定して、次を描き始める。
 * 選んでいる道具をもう一度押すのが「新しく描く」にあたる。
 */
export async function startNew(page: Page, tool: Tool = 'manual'): Promise<void> {
  await setTool(page, tool);
}

/** 一覧の各行。田んぼも計測もピンも同じ形で並ぶ。 */
export async function itemRows(
  page: Page
): Promise<{ name: string; value: string; kind: string; selected: boolean; visible: boolean }[]> {
  return page.$$eval('#items li', (items) =>
    items.map((li) => ({
      name: li.querySelector('.item-name')?.textContent ?? '',
      value: li.querySelector('.item-value')?.textContent ?? '',
      kind: li.getAttribute('data-kind') ?? '',
      selected: li.classList.contains('selected'),
      visible: li.querySelector('.item-visible')?.getAttribute('aria-pressed') === 'true',
    }))
  );
}

/** 一覧の行を選ぶ。 */
export async function selectRow(page: Page, index: number): Promise<void> {
  await page.locator('#items li .item-select').nth(index).click();
  await page.waitForTimeout(500);
}

/** 一覧の行の表示・非表示を切り替える。 */
export async function toggleRowVisible(page: Page, index: number): Promise<void> {
  await page.locator('#items li .item-visible').nth(index).click();
  await page.waitForTimeout(250);
}

/** 設定のシートを開く。 */
export async function openSettings(page: Page): Promise<void> {
  await page.locator('#settings-open').click();
  await page.waitForTimeout(200);
}

/** 画素を数えるときの見方。田んぼの既定色（#ffb300）か、何か描かれているか。 */
type PixelKind = 'drawn' | 'covered';

/**
 * 地図の canvas の画素を数える。
 *
 * 面積は出ているのに地図には何も出ない、という壊れ方があるので、数値ではなく画を見る。
 * `drawn` は田んぼの色に一致した画素数。写真にも近い色の土や屋根が写るので、絶対数ではなく
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
          ? red > 215 && green > 140 && green < 205 && blue < 70
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
