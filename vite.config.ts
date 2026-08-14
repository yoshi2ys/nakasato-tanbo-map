import { defineConfig } from 'vite';

export default defineConfig({
  // maplibre-gl は worker を `new Worker(url, { type: 'module' })` で起こすので、
  // Vite 側も ES 形式で worker を出力する必要がある。
  worker: { format: 'es' },
});
