// 把 assets-src 里的原图批量压成 Web 用的 256/512 WebP + 512 JPEG 回退。
// 依赖：PATH 里有 ffmpeg（带 libwebp）。
// 运行：node scripts/build-images.mjs [--force]（不带 --force 时跳过已存在的产物）
import { spawnSync } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const jobs = [
  { src: 'assets-src/cards', out: 'public/assets/cards' },
  { src: 'assets-src/landmarks', out: 'public/assets/landmarks' },
  { src: 'assets-src/dlc', out: 'dlc1/assets/cards' },
];

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr.toString().trim()}`);
  }
}

function squareFilter(size) {
  return `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`;
}

async function convert(inputDir, outDir, file) {
  const input = path.join(inputDir, file);
  const id = file.replace(/\.[^.]+$/, '');
  const outputs = [
    { name: `${id}-256.webp`, args: ['-vf', squareFilter(256), '-c:v', 'libwebp', '-quality', '72', '-compression_level', '6'] },
    { name: `${id}-512.webp`, args: ['-vf', squareFilter(512), '-c:v', 'libwebp', '-quality', '78', '-compression_level', '6'] },
  ];
  for (const output of outputs) {
    const target = path.join(outDir, output.name);
    const existing = await stat(target).catch(() => null);
    if (existing && !force) continue;
    ffmpeg(['-i', input, ...output.args, target]);
  }
  const fallback = path.join(outDir, `${id}-512.jpg`);
  const existingFallback = await stat(fallback).catch(() => null);
  if (!existingFallback || force) {
    ffmpeg(['-i', input, '-vf', squareFilter(512), '-q:v', '4', fallback]);
  }
  return outputs.map(output => output.name).concat([`${id}-512.jpg`]);
}

let count = 0;
for (const job of jobs) {
  const sourceDir = path.join(root, job.src);
  const outDir = path.join(root, job.out);
  const files = (await readdir(sourceDir)).filter(file => /\.(png|jpe?g)$/i.test(file));
  for (const file of files) {
    await convert(sourceDir, outDir, file);
    count += 1;
    console.log(`[assets] ${job.src}/${file} -> 256/512 webp + 512 jpg`);
  }
}
console.log(`[assets] done: ${count} source images`);
