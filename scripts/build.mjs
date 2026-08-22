import * as esbuild from 'esbuild';
import { promises as fs, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

const isWatch = process.argv.includes('--watch');

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dest);
    } else {
      await fs.copyFile(src, dest);
    }
  }
}

async function copyStaticAssets() {
  await fs.mkdir(distDir, { recursive: true });
  await fs.copyFile(path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
  for (const page of ['result.html', 'options.html']) {
    await fs.copyFile(path.join(srcDir, page), path.join(distDir, page));
  }
  await copyDir(path.join(srcDir, 'icons'), path.join(distDir, 'icons'));
  await copyDir(path.join(srcDir, '_locales'), path.join(distDir, '_locales'));
  await copyDir(path.join(root, 'licenses'), path.join(distDir, 'licenses'));
}

// jsPDFがhtml()用に動的importしているレンダラ群。写しはcanvasから直接PDFを作るため
// 使わないが、放置するとバンドルに取り込まれて1.5MBまで膨らむ（core-js等を巻き込むため）。
// 空モジュールに差し替えて締め出す。html()を呼ばない限り実行時に参照されない。
const excludeUnusedJsPdfRenderers = {
  name: 'exclude-unused-jspdf-renderers',
  setup(build) {
    const pattern = /^(canvg|dompurify|html2canvas)$/;
    build.onResolve({ filter: pattern }, (args) => ({
      path: args.path,
      namespace: 'utsushi-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'utsushi-stub' }, () => ({
      contents: 'export default undefined;',
      loader: 'js',
    }));
  },
};

// jsPDFのoutput('pdfobjectnewwindow')は、PDFプレビュー用にCDNのスクリプトを読み込む。
// 写しはoutput('blob')しか使わないため実行されないが、外部URLが配布物に残っていると
// 「通信ゼロ」（NFR-01）をgrepで確認できなくなるので、ビルド時に空文字へ潰しておく。
const stripRemoteScriptUrl = {
  name: 'strip-remote-script-url',
  setup(build) {
    const CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js';
    build.onLoad({ filter: /jspdf[\\/]dist[\\/]jspdf\.es(\.min)?\.js$/ }, async (args) => {
      const source = await fs.readFile(args.path, 'utf8');
      if (!source.includes(CDN_URL)) {
        // jsPDFの更新で文字列が変わったら気付けるようにする
        console.warn('[build] jsPDF内のCDN URLが見つかりませんでした（除去処理を見直すこと）');
      }
      return { contents: source.split(CDN_URL).join(''), loader: 'js' };
    });
  },
};

const common = {
  outdir: distDir,
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  platform: 'browser',
  plugins: [excludeUnusedJsPdfRenderers, stripRemoteScriptUrl],
  sourcemap: isWatch ? 'inline' : false,
  logLevel: 'info',
};

// Service Workerは圧縮しない。chrome.scripting.executeScript の func は関数を
// シリアライズして注入するため、圧縮による変形は「ビルドは通るのに実行時だけ壊れる」
// 事故に直結する。background.jsは小さく、圧縮しても数KBしか変わらないので割に合わない。
const backgroundOptions = {
  ...common,
  entryPoints: [path.join(srcDir, 'background.ts')],
  minify: false,
};

// 結果ページは同梱ライブラリ（jsPDF）が大きいため配布ビルドでは圧縮する。
// watch中は読めるままにしておく（デバッグのため）。
const pageOptions = {
  ...common,
  entryPoints: [path.join(srcDir, 'result.ts'), path.join(srcDir, 'options.ts')],
  minify: !isWatch,
};

if (isWatch) {
  for (const options of [backgroundOptions, pageOptions]) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  await copyStaticAssets();

  fsWatch(srcDir, { recursive: true }, (_event, filename) => {
    if (filename && /\.(json|html|png|txt|md)$/.test(filename)) {
      copyStaticAssets()
        .then(() => console.log('[build] static assets updated:', filename))
        .catch((err) => console.error('[build] static asset copy failed', err));
    }
  });

  console.log('[build] watching for changes (Ctrl+C で終了)');
} else {
  await esbuild.build(backgroundOptions);
  await esbuild.build(pageOptions);
  await copyStaticAssets();
  console.log('[build] done ->', path.relative(root, distDir));
}
