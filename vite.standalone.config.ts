import { defineConfig, type Plugin } from 'vite';

/**
 * すべてを 1 つの HTML に畳み込むビルド。`file://` でダブルクリックして開ける成果物を作る。
 *
 * `file://` は ES module の読み込みを CORS で弾くので、外部ファイル参照が 1 つでも残ると動かない。
 * 逆に inline の module script は許されるため、CSS・JS・worker をすべて HTML に埋め込む。
 * OpenCV.js（13MB）は `assetsInlineLimit` が data URI にしてくれる。
 */
function singleFile(): Plugin {
  return {
    name: 'tanbo-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (item) => item.type === 'chunk' && item.isEntry,
      );
      if (entry?.type !== 'chunk') throw new Error('エントリチャンクが見つかりません');

      // HTML に畳んだファイルの控え。`delete bundle[…]` は出力からは消えるが、
      // 直後に読み返しても消えて見えないため、取り込み漏れは自前で数える。
      const inlined = new Set<string>([entry.fileName]);

      // worker は `new URL(..., import.meta.url)` で参照される。inline HTML では import.meta.url が
      // HTML 自身の URL になり実体がないので、参照ごと埋め込んだ worker の URL に差し替える。
      let workerSource: string | null = null;
      entry.code = entry.code.replace(
        /new URL\((["'`])([^"'`]+\.js)\1,\s*import\.meta\.url\)(\.href)?/g,
        (match, _quote: string, fileName: string) => {
          // 参照は assetsDir を含まないファイル名なので、bundle 側のキーは末尾一致で探す。
          const key = Object.keys(bundle).find(
            (name) => name === fileName || name.endsWith(`/${fileName}`),
          );
          if (key === undefined) return match;
          const worker = bundle[key];
          if (worker === undefined) return match;
          workerSource = worker.type === 'chunk' ? worker.code : String(worker.source);
          inlined.add(key);
          delete bundle[key];
          return WORKER_URL_NAME;
        },
      );
      if (workerSource !== null) entry.code = `${workerUrlSource(workerSource)}\n${entry.code}`;

      const styles: string[] = [];
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type === 'asset' && fileName.endsWith('.css')) {
          styles.push(String(item.source));
          inlined.add(fileName);
          delete bundle[fileName];
        }
      }

      const html = bundle['index.html'];
      if (html?.type !== 'asset') throw new Error('index.html が見つかりません');
      // 外部ファイルへの参照は 1 つ残らず畳む。1 つでも残ると `file://` ではそこで止まる。
      html.source = String(html.source)
        .replace(/<script type="module"[^>]*><\/script>/g, '')
        .replace(/<link rel="stylesheet"[^>]*>/, `<style>${styles.join('\n')}</style>`)
        .replace(/<link rel="stylesheet"[^>]*>/g, '')
        .replace('</body>', `<script type="module">${escapeScript(entry.code)}</script>\n</body>`);
      delete bundle[entry.fileName];

      // 取り込み漏れたファイルが 1 つでもあると、`file://` ではそこで動かなくなる。
      // ビルドは成功したように見えてしまうので、ここで落として気づけるようにする。
      const left = Object.keys(bundle).filter(
        (name) => name !== 'index.html' && !inlined.has(name),
      );
      if (left.length > 0) {
        throw new Error(`単一 HTML に取り込めなかったファイルがあります: ${left.join(', ')}`);
      }
    },
  };
}

/** 埋め込んだ worker の blob URL を入れる変数名。エントリ側の参照もこれに差し替える。 */
const WORKER_URL_NAME = '__tanboWorkerUrl';

/**
 * `file://` では module worker を起動できない。blob URL 越しでも同じで、`new Worker` は
 * 例外を投げずに非同期の error で死ぬため、maplibre のフォールバックにも引っかからない。
 * 症状は「航空写真は出るのに、描いた線と頂点だけ出ない」——GeoJSON の処理だけが worker 側にあるため。
 *
 * maplibre は渡された URL が `.cjs` で終わるときだけ classic worker として起こす。
 * blob URL の末尾にフラグメントを足せばその判定を満たせて、取得のほうは
 * フラグメントが無視されるので中身は届く。worker は iife で出してある。
 */
function workerUrlSource(source: string): string {
  return `const ${WORKER_URL_NAME}=URL.createObjectURL(new Blob([${jsString(source)}],{type:"text/javascript"}))+"#.cjs";`;
}

/** JS のソースを、別の JS の文字列リテラルとして埋め込める形にする。 */
function jsString(source: string): string {
  return JSON.stringify(source);
}

/**
 * `</script` は、たとえ文字列リテラルの中にあっても HTML パーサが script の終わりとみなす。
 * JS では `<\/script` が同じ文字列を表すので、そちらに書き換えて閉じられないようにする。
 */
function escapeScript(code: string): string {
  return code.replaceAll('</script', '<\\/script');
}

export default defineConfig({
  base: './',
  // classic worker として起動させるので、import 文の出ない iife で出力する。
  worker: { format: 'iife' },
  build: {
    outDir: 'dist-standalone',
    // OpenCV.js を data URI として埋め込ませるため、上限を撤廃する。
    assetsInlineLimit: () => true,
    // 1 ファイルに畳むので、チャンクが大きいという警告は意味がない。
    chunkSizeWarningLimit: Infinity,
  },
  plugins: [singleFile()],
});
