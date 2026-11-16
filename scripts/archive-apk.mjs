// scripts/archive-apk.mjs
// 读取 android/app/build.gradle 的 versionName/versionCode，把构建产物归档为：
// APK/轻小说阅读器-v<versionName>-android-debug.apk
// 同时更新 APK/versions.json 与 APK/版本清单.md，不覆盖已有版本。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
const sourcePath = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const archiveDir = path.join(root, 'APK');
const manifestPath = path.join(archiveDir, 'versions.json');
const markdownPath = path.join(archiveDir, '版本清单.md');

if (!fs.existsSync(sourcePath)) {
  console.error('APK not found:', sourcePath);
  process.exit(1);
}

const gradle = fs.readFileSync(gradlePath, 'utf8');
const versionCode = Number((gradle.match(/versionCode\s+(\d+)/) || [])[1] || 0);
const versionName = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1] || '0.0';
if (!versionCode || !versionName) {
  console.error('Cannot read versionCode/versionName from', gradlePath);
  process.exit(1);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const sourceHash = sha256(sourcePath);
const sourceSize = fs.statSync(sourcePath).size;
const builtAt = new Date(fs.statSync(sourcePath).mtimeMs).toISOString();

fs.mkdirSync(archiveDir, { recursive: true });

let archiveName = `轻小说阅读器-v${versionName}-android-debug.apk`;
let archivePath = path.join(archiveDir, archiveName);
if (fs.existsSync(archivePath)) {
  const existingHash = sha256(archivePath);
  if (existingHash !== sourceHash) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    archiveName = `轻小说阅读器-v${versionName}-rebuild-${stamp}-android-debug.apk`;
    archivePath = path.join(archiveDir, archiveName);
  }
}
if (!fs.existsSync(archivePath) || sha256(archivePath) !== sourceHash) {
  fs.copyFileSync(sourcePath, archivePath);
}
const archiveHash = sha256(archivePath);

// 根目录也放一份“带版本号”的当前 APK；不再保留无版本号文件名
const rootVersioned = path.join(root, `轻小说阅读器-v${versionName}-android-debug.apk`);
fs.copyFileSync(archivePath, rootVersioned);
const legacyUnversioned = path.join(root, '轻小说阅读器-android-debug.apk');
if (fs.existsSync(legacyUnversioned)) fs.rmSync(legacyUnversioned, { force: true });

let manifest = { app: 'light-novel-reader', package: 'com.example.lightnovelreader', versions: [] };
if (fs.existsSync(manifestPath)) {
  try { manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')) }; } catch (e) {}
}
manifest.versions = Array.isArray(manifest.versions) ? manifest.versions : [];

const entry = {
  versionName,
  versionCode,
  file: archiveName,
  size: archiveHash === sourceHash ? sourceSize : fs.statSync(archivePath).size,
  sha256: archiveHash,
  builtAt,
  archivedAt: new Date().toISOString(),
  available: true
};

// 同一 versionCode+同一 hash 只保留一条；不同 hash（同版本重建）保留不同文件
const same = manifest.versions.find((v) => v.versionCode === versionCode && v.sha256 === archiveHash);
if (!same) manifest.versions.push(entry);
else Object.assign(same, entry);

manifest.versions.sort((a, b) => b.versionCode - a.versionCode || String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

const rows = manifest.versions.map((v) => {
  const file = v.available ? `[${v.file}](./${encodeURI(v.file)})` : '（未归档）';
  return `| v${v.versionName} | ${v.versionCode} | ${file} | ${v.size || '—'} | ${v.sha256 || '—'} | ${v.builtAt || '—'} | ${v.available ? '已保留' : '缺失'} |`;
});
const md = `# APK 版本归档\n\n` +
  `- 包名：\`com.example.lightnovelreader\`\n` +
  `- 命名规则：\`轻小说阅读器-v<versionName>-android-debug.apk\`\n` +
  `- 根目录只保留当前版本的带版本号 APK；历史版本全部在 \`APK/\`。\n` +
  `- 升级前先在 \`android/app/build.gradle\` 修改 versionCode/versionName，再构建并运行 \`npm run apk:archive\`。\n\n` +
  `| 版本 | versionCode | 文件 | 大小(bytes) | SHA-256 | 构建时间(UTC) | 状态 |\n` +
  `| --- | --- | --- | --- | --- | --- | --- |\n` +
  rows.join('\n') + '\n';
fs.writeFileSync(markdownPath, md, 'utf8');

console.log(JSON.stringify({ archivePath, rootVersioned, sha256: archiveHash, versionName, versionCode, size: sourceSize }, null, 2));
