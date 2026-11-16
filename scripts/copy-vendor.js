// scripts/copy-vendor.js
// 把 epub.js 的浏览器构建产物复制到 renderer/vendor/epub.min.js，
// 确保阅读器完全离线可用，绝不使用 CDN。
//
// 用法：npm run copy:vendor（也会在 postinstall / dev / build:win 前自动执行）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const destDir = path.join(root, 'renderer', 'vendor');

// epub.js 的浏览器构建依赖全局 JSZip，必须一并复制 jszip.min.js，
// 否则加载 ArrayBuffer 时会抛出 “JSZip lib not loaded”。
const copies = [
  { name: 'epub.min.js', src: path.join(root, 'node_modules', 'epubjs', 'dist', 'epub.min.js') },
  { name: 'jszip.min.js', src: path.join(root, 'node_modules', 'jszip', 'dist', 'jszip.min.js') }
];

try {
  for (const item of copies) {
    if (!fs.existsSync(item.src)) {
      console.error('[copy-vendor] 未找到源文件：' + item.src);
      console.error('[copy-vendor] 请先执行 npm install 安装 epubjs / jszip 依赖');
      process.exit(1);
    }
  }

  fs.mkdirSync(destDir, { recursive: true });
  for (const item of copies) {
    const dest = path.join(destDir, item.name);
    fs.copyFileSync(item.src, dest);
    const size = fs.statSync(dest).size;
    console.log(`[copy-vendor] 已复制 ${item.name} -> ${path.relative(root, dest)} (${(size / 1024).toFixed(1)} KB)`);
  }
} catch (e) {
  console.error('[copy-vendor] 复制失败：', e);
  process.exit(1);
}
