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
  await fs.copyFile(path.join(srcDir, 'result.html'), path.join(distDir, 'result.html'));
  await copyDir(path.join(srcDir, 'icons'), path.join(distDir, 'icons'));
}

const buildOptions = {
  entryPoints: [path.join(srcDir, 'background.ts'), path.join(srcDir, 'result.ts')],
  outdir: distDir,
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  platform: 'browser',
  sourcemap: isWatch ? 'inline' : false,
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  await copyStaticAssets();

  fsWatch(srcDir, { recursive: true }, (_event, filename) => {
    if (filename && /\.(json|html|png)$/.test(filename)) {
      copyStaticAssets()
        .then(() => console.log('[build] static assets updated:', filename))
        .catch((err) => console.error('[build] static asset copy failed', err));
    }
  });

  console.log('[build] watching for changes (Ctrl+C で終了)');
} else {
  await esbuild.build(buildOptions);
  await copyStaticAssets();
  console.log('[build] done ->', path.relative(root, distDir));
}
