import { defineConfig } from '@playwright/test';

/** `npm run test:dist` は build 済みの dist を preview で配る。既定は dev サーバ。 */
const useDist = process.env['TANBO_TEST_DIST'] === '1';
const port = useDist ? 4173 : 5173;
/** `npm run test:standalone` は単一 HTML を file:// で開くので、サーバを立てない。 */
const useStandalone = process.env['TANBO_TEST_STANDALONE'] === '1';

export default defineConfig({
  testDir: 'tests',
  // 自動検出は OpenCV.js の 13MB 読み込みと WASM 実行を含むので、既定の 30 秒では足りない。
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // 地図タイルを取りに行くので、並列で回すと外部サーバへの負荷が読めない。
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    // standalone はサーバを立てないので、baseURL を残すと `/…` への goto が
    // 動いていないサーバ（や無関係な dev サーバ）を向いて静かに嘘をつく。
    baseURL: useStandalone ? undefined : `http://localhost:${port}`,
    viewport: { width: 1200, height: 800 },
    // 検出結果は表示中の画像から作るので、画面サイズと解像度は固定する。
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
  // devices の指定は viewport を上書きしてしまう。検出は表示中の画像から作るので、
  // 画面サイズがずれるとシードの位置が変わり、テストの意味が変わる。
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: useStandalone
    ? undefined
    : {
        command: useDist ? 'npm run build && npm run preview' : 'npm run dev',
        port,
        reuseExistingServer: !process.env['CI'],
        timeout: 300_000,
      },
});
