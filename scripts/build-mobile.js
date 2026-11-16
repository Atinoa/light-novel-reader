// scripts/build-mobile.js
// 生成 Capacitor 的静态 webDir：renderer -> www，并注入移动端适配层。
// 桌面 renderer/main/preload 不改动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const www = path.join(root, 'www');
const renderer = path.join(root, 'renderer');
const mobile = path.join(root, 'platform', 'mobile');
const zipVendor = path.join(root, 'node_modules', '@zip.js', 'zip.js', 'dist', 'zip.min.js');

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(renderer, www, { recursive: true });

for (const file of ['mobile-api.js', 'mobile-boot.js', 'mobile.css']) {
  fs.copyFileSync(path.join(mobile, file), path.join(www, file));
}

if (fs.existsSync(zipVendor)) {
  fs.mkdirSync(path.join(www, 'vendor'), { recursive: true });
  fs.copyFileSync(zipVendor, path.join(www, 'vendor', 'zip.min.js'));
} else {
  console.warn('WARN: @zip.js/zip.js dist not found; 500MB archive will fall back to JSZip');
}

let html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');

html = html.replace(
  '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />'
);

// epub.js 会用 blob: iframe/资源替换；只放行本地 blob 与 Capacitor localhost
html = html.replace("default-src 'self';", "default-src 'self' blob: data:;");
html = html.replace(
  "script-src 'self' 'unsafe-eval' 'unsafe-inline';",
  "script-src 'self' blob: 'unsafe-eval' 'unsafe-inline';"
);
html = html.replace(
  "style-src 'self' 'unsafe-inline';",
  "style-src 'self' blob: 'unsafe-inline';"
);
html = html.replace(
  "media-src 'self' data: blob:",
  "media-src 'self' data: blob: https://localhost http://localhost capacitor:; worker-src 'self' blob:; frame-src 'self' blob: data: https://localhost http://localhost; child-src 'self' blob: data: https://localhost http://localhost"
);
html = html.replace(
  "img-src 'self' data: blob: manga:;",
  "img-src 'self' data: blob: manga: https://localhost http://localhost capacitor:;"
);
html = html.replace(
  "connect-src 'self' blob: data: manga:;",
  "connect-src 'self' blob: data: manga: https://localhost http://localhost capacitor:;"
);

html = html.replace(
  '<link rel="stylesheet" href="./styles.css" />',
  '<link rel="stylesheet" href="./styles.css" />\n  <link rel="stylesheet" href="./mobile.css" />'
);

html = html.replace(
  '<script src="./library.js"></script>',
  '<script src="./vendor/zip.min.js"></script>\n  <script src="./mobile-api.js"></script>\n  <script src="./library.js"></script>'
);

html = html.replace(
  '<script src="./app.js"></script>',
  '<script src="./mobile-boot.js"></script>\n  <script src="./app.js"></script>'
);

// 移动 WebView 下 meta CSP 会让 epub.js 的 blob 资源队列卡住；
// 移动端只加载 www 本地静态资源 + 用户本地文件，且 epub.js 已禁用脚本，
// 因此移动构建移除 meta CSP；桌面 renderer 的 CSP 保持不变。
html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');

fs.writeFileSync(path.join(www, 'index.html'), html, 'utf8');
console.log(`mobile web built: ${www}`);
