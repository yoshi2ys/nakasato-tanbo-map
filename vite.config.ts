import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** GitHub Pages の公開先。`https://yoshi2ys.github.io/nakasato-tanbo-map/` に置く。 */
const BASE = '/nakasato-tanbo-map/';

export default defineConfig({
  base: BASE,
  // maplibre-gl は worker を `new Worker(url, { type: 'module' })` で起こすので、
  // Vite 側も ES 形式で worker を出力する必要がある。
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '中里 田んぼマップ',
        short_name: '田んぼマップ',
        description: '航空写真から田んぼの輪郭を描いて面積を出す道具',
        lang: 'ja',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      workbox: {
        // アプリ本体（数百 KB）だけを先に取っておく。写真タイルは src/tileCache.ts が
        // IndexedDB に持つので、Service Worker とは役割を分ける。
        globPatterns: ['**/*.{js,css,html}'],
        // OpenCV.js は 13MB ある。自動検出を初めて使うときまで取りに行かないのが本来の
        // 設計なので、先読みからは外し、使ったぶんだけ下の runtimeCaching に載せる。
        globIgnores: ['**/opencv-*.js'],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/opencv-.*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opencv',
              expiration: { maxEntries: 2 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
