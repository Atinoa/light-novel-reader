// main.js
// 轻小说 EPUB 阅读器 —— 主进程
// 负责：窗口创建、文件夹递归扫描、文件读取（带白名单校验）、
//       electron-store 持久化、系统对话框与资源管理器打开。

import { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Store from 'electron-store';
import yauzl from 'yauzl';
import { decodeBuffer, detectEncoding } from './txt-decoder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TXT 大文件阈值：超过 20MB 仅提示但仍允许打开；超过 250MB 直接拒绝，避免内存耗尽崩溃
const LARGE_TXT_BYTES = 20 * 1024 * 1024;
const MAX_TXT_BYTES = 250 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 漫画相关常量
// ---------------------------------------------------------------------------
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp']);
const MANGA_ZIP_EXTS = new Set(['.zip', '.cbz', '.pkz']); // PKZ 本质也是 ZIP
const MANGA_UNSUPPORTED_EXTS = new Set(['.cbr', '.rar']);
const MIN_MANGA_IMAGES = 3;
const MANGA_LARGE_ZIP_BYTES = 500 * 1024 * 1024; // 超大 CBZ 提示阈值
const MANGA_MAX_ENTRIES = 2000;                  // 条目数提示阈值
const MANGA_LARGE_IMAGE_BYTES = 20 * 1024 * 1024; // 单张超大图片提示阈值
const MANGA_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp'
};

// 自定义协议必须在 app ready 之前注册为特权 scheme，
// 否则 <img src="manga://..."> 与 fetch 都无法正常工作。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'manga',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
]);

// ---------------------------------------------------------------------------
// electron-store：持久化书库、设置、阅读进度、书签。
// 数据保存在 Electron userData 目录下的 reader-data.json。
// ---------------------------------------------------------------------------
const store = new Store({
  name: 'reader-data',
  defaults: {
    folders: [],    // 书库文件夹列表 [{ path, name, addedAt }]
    books: [],      // 书籍列表 + 元数据缓存 [{ path, name, size, mtime, title, author, cover, ... }]
    bookData: {},   // 每本书进度/书签，key 为规范化路径 { [path]: { cfi, percent, bookmarks, ... } }
    settings: {},   // 全局阅读设置
    recent: [],     // 最近打开的书籍路径
    txtCache: {}    // TXT 章节解析缓存 { [path]: { mtime, size, encoding, chapters } }
  }
});

// ---------------------------------------------------------------------------
// 路径白名单（内存态）。
// read-epub 只允许读取：
//   1. 书库中已登记的书籍路径；
//   2. 已登记书库文件夹内的路径；
//   3. 用户刚刚通过“打开文件”对话框或“拖拽”选择的路径。
// 拒绝任意路径读取。
// ---------------------------------------------------------------------------
const allowedPaths = new Set();

let mainWindow = null;

// 规范化绝对路径
const norm = (p) => path.resolve(String(p));
// Windows 下不区分大小写的规范化键（用于去重与白名单比较）
const normKey = (p) => norm(p).replace(/\\/g, '/').toLowerCase();

// 判断某绝对路径是否允许读取
function isPathAllowed(abs) {
  if (allowedPaths.has(abs)) return true;
  const key = normKey(abs);

  for (const b of store.get('books', [])) {
    if (b && typeof b.path === 'string' && normKey(b.path) === key) return true;
  }
  for (const f of store.get('folders', [])) {
    if (f && typeof f.path === 'string') {
      const rootBase = normKey(f.path).replace(/\/+$/, '');
      if (key === rootBase) return true;
      if (key.startsWith(rootBase + '/')) return true;
    }
  }
  // 已登记的漫画文件夹：允许读取其内部图片（供 manga:// 协议使用）
  // 使用 mangaRegistry（扫描/持久化时登记）作为白名单来源
  for (const entry of mangaRegistry.values()) {
    if (entry && entry.sourceType === 'folder') {
      const rootBase = normKey(entry.path).replace(/\/+$/, '');
      if (key === rootBase) return true;
      if (key.startsWith(rootBase + '/')) return true;
    }
  }
  return false;
}

// 启动时把已持久化的路径加入白名单，保证重启后仍可读取书库文件
function hydrateAllowedPaths() {
  for (const b of store.get('books', [])) {
    if (b && typeof b.path === 'string') allowedPaths.add(norm(b.path));
  }
  for (const f of store.get('folders', [])) {
    if (f && typeof f.path === 'string') allowedPaths.add(norm(f.path));
  }
}

// 旧数据没有 sourceFolder 时：按已登记书库文件夹反推；不在任何文件夹下则归入单本导入
function inferSourceFolder(bookPath) {
  const key = normKey(bookPath);
  let best = null;
  for (const f of store.get('folders', [])) {
    if (!f || typeof f.path !== 'string') continue;
    const fk = normKey(f.path).replace(/\/+$/, '');
    if (key === fk || key.startsWith(fk + '/')) {
      if (!best || fk.length > best.key.length) best = { key: fk, path: norm(f.path) };
    }
  }
  return best ? best.path : '__single_imports__';
}

// ---------------------------------------------------------------------------
// 漫画工具函数：图片过滤、自然排序、manga:// 注册表、ZIP 条目列表
// ---------------------------------------------------------------------------
const mangaRegistry = new Map(); // mangaId -> { path, sourceType }

function mangaIdFor(p) {
  return crypto.createHash('sha1').update(normKey(p)).digest('hex').slice(0, 16);
}

function isImageFileName(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  if (!base || base.startsWith('.')) return false;
  if (/^(thumbs\.db|desktop\.ini)$/i.test(base)) return false;
  return IMAGE_EXTS.has(path.extname(base).toLowerCase());
}

function isIgnoredMangaPath(name) {
  const parts = String(name || '').replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '__MACOSX' || p.startsWith('.'))) return true;
  const base = parts[parts.length - 1];
  return /^(thumbs\.db|desktop\.ini)$/i.test(base);
}

// PKZ 本质是 ZIP 容器，但内部条目常为 UUID 无扩展名，不能只靠扩展名判断
function isPkzPath(p) {
  return path.extname(String(p || '')).toLowerCase() === '.pkz';
}

// 自然排序：保证 2.jpg 排在 10.jpg 之前
function naturalCompare(a, b) {
  const tokenize = (s) => String(s).match(/\d+|\D+/g) || [];
  const aa = tokenize(a);
  const bb = tokenize(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i];
    const y = bb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d;
    } else {
      const d = x.localeCompare(y, 'zh-CN', { sensitivity: 'base' });
      if (d !== 0) return d;
    }
  }
  return 0;
}

function mimeForImage(name) {
  return MANGA_MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

// PKZ 的 UUID 条目没有扩展名，需要通过文件头判断真实图片格式
function sniffImageMime(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 4) return '';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.slice(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  return '';
}

// PKZ 载荷使用逐字节 XOR 0xAA 的轻量混淆
function xorAaBuffer(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const out = Buffer.alloc(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] ^ 0xAA;
  return out;
}

function registerMangaBook(book) {
  if (!book || book.type !== 'manga' || typeof book.path !== 'string') return null;
  const id = book.mangaId || mangaIdFor(book.path);
  mangaRegistry.set(id, {
    path: norm(book.path),
    sourceType: book.sourceType === 'zip' ? 'zip' : 'folder'
  });
  return id;
}

function hydrateMangaRegistry() {
  for (const b of store.get('books', [])) registerMangaBook(b);
}

async function listFolderImages(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || isIgnoredMangaPath(ent.name) || !isImageFileName(ent.name)) continue;
    try {
      const st = await fs.promises.stat(path.join(dir, ent.name));
      out.push({ name: ent.name, size: st.size });
    } catch (e) { /* 跳过 */ }
  }
  out.sort((a, b) => naturalCompare(a.name, b.name));
  return out;
}

// 只读取 ZIP 中央目录，不解压；返回按自然排序的图片条目
function listZipImages(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const images = [];
      let settled = false;
      const finish = (e) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        if (e) reject(e); else resolve(images);
      };
      zipfile.on('error', finish);
      zipfile.on('entry', (entry) => {
        const name = String(entry.fileName || '').replace(/\\/g, '/');
        if (!name.endsWith('/') && !isIgnoredMangaPath(name) && isImageFileName(name)) {
          images.push({ name, size: entry.uncompressedSize || 0 });
        }
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        images.sort((a, b) => naturalCompare(a.name, b.name));
        finish();
      });
      zipfile.readEntry();
    });
  });
}

// 读取 ZIP 中央目录中的全部条目（不解压），保持中央目录顺序
function listZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = [];
      let settled = false;
      const finish = (e) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        if (e) reject(e); else resolve(entries);
      };
      zipfile.on('error', finish);
      zipfile.on('entry', (entry) => {
        const name = String(entry.fileName || '').replace(/\\/g, '/');
        if (!name.endsWith('/')) entries.push({ name, size: entry.uncompressedSize || 0 });
        zipfile.readEntry();
      });
      zipfile.on('end', () => finish());
      zipfile.readEntry();
    });
  });
}

// 读取单个 ZIP 条目为 Buffer（不解码、不落盘）
function readZipEntryBuffer(zipPath, entryName, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return resolve(null);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        resolve(value);
      };
      zipfile.on('error', () => finish(null));
      zipfile.on('entry', (entry) => {
        const name = String(entry.fileName || '').replace(/\\/g, '/');
        if (name !== entryName) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2) return finish(null);
          const chunks = [];
          let size = 0;
          stream.on('data', (chunk) => {
            if (size >= maxBytes) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const take = buf.slice(0, maxBytes - size);
            chunks.push(take);
            size += take.length;
          });
          stream.on('end', () => finish(Buffer.concat(chunks)));
          stream.on('error', () => finish(null));
        });
      });
      zipfile.on('end', () => finish(null));
      zipfile.readEntry();
    });
  });
}

// 从 PKZ-INFO 中按 volumes/chapters/pictures 展平页序（idx 为章节内页序）
function collectPkzPages(info) {
  const out = [];
  const comics = Array.isArray(info && info.comics) ? info.comics : [];
  for (const comic of comics) {
    for (const vol of (Array.isArray(comic.volumes) ? comic.volumes : [])) {
      for (const chap of (Array.isArray(vol.chapters) ? vol.chapters : [])) {
        const pics = Array.isArray(chap.pictures) ? chap.pictures.slice() : [];
        pics.sort((a, b) => (Number(a && a.idx) || 0) - (Number(b && b.idx) || 0));
        for (const pic of pics) {
          const name = pic && pic.picture_path ? String(pic.picture_path) : '';
          if (!name) continue;
          out.push({
            name,
            size: 0,
            title: pic.title ? String(pic.title) : '',
            width: Number(pic.width) || 0,
            height: Number(pic.height) || 0
          });
        }
      }
    }
  }
  // 同一图片被多个章节引用时去重，保持首次出现的页序
  const seen = new Set();
  return out.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

// 解析 PKZ：PKZ-INFO 可能是明文 JSON，也可能是 XOR 0xAA 后的 JSON
async function readPkzArchive(zipPath) {
  try {
    const entries = await listZipEntries(zipPath);
    const infoEntry = entries.find((e) => e.name.toLowerCase() === 'pkz-info');
    if (!infoEntry) return null;
    const raw = await readZipEntryBuffer(zipPath, infoEntry.name);
    if (!raw) return null;

    const parseJson = (buf) => {
      try {
        const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
        if (!text.startsWith('{')) return null;
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    };
    let encoded = false;
    let info = parseJson(raw);
    if (!info) {
      info = parseJson(xorAaBuffer(raw));
      if (info) encoded = true;
    }
    if (!info) return null;

    const pages = collectPkzPages(info);
    const sizeMap = new Map(entries.map((e) => [e.name, e.size]));
    for (const p of pages) p.size = sizeMap.get(p.name) || 0;

    const comics = Array.isArray(info.comics) ? info.comics : [];
    let cover = '';
    for (const c of comics) {
      if (c && typeof c.cover_path === 'string' && c.cover_path) { cover = c.cover_path; break; }
    }
    if (!cover && typeof info.cover_path === 'string') cover = info.cover_path;
    if (!cover && pages.length) cover = pages[0].name;

    return { info, pages, cover, encoded };
  } catch (e) {
    return null;
  }
}

// 将 PKZ-INFO 映射到书库字段：书名、作者、卷/话、封面
function applyPkzInfo(entry, info, cover) {
  if (!info) return;
  const comics = Array.isArray(info.comics) ? info.comics : [];
  const comic = comics[0] || {};
  const title = comic.title || info.name || '';
  const author = comic.author || info.author || '';

  if (title) entry.title = title;
  if (author) entry.author = author;

  const vol = (Array.isArray(comic.volumes) && comic.volumes[0]) || {};
  const chapter = (Array.isArray(vol.chapters) && vol.chapters[0]) || {};
  if (vol.title) entry.volume = String(vol.title);
  // 有些源的 chapter.title 实际是汉化组名（例如 MotherEmperor），只展示像“第1話/全彩”的章节名
  const chapterTitle = chapter.title ? String(chapter.title) : '';
  const team = comic.chinese_team ? String(comic.chinese_team) : '';
  if (chapterTitle && chapterTitle !== team && /第|話|话|卷|集|章|chapter|ch\.?|全彩|熟肉/i.test(chapterTitle)) {
    entry.chapter = chapterTitle;
  }
  if (cover) entry.coverPath = cover;

  entry.pkzInfo = {
    title,
    author,
    description: comic.description || info.description || '',
    tags: Array.isArray(comic.tags) ? comic.tags : [],
    categories: Array.isArray(comic.categories) ? comic.categories : [],
    chapter: chapter.title ? String(chapter.title) : ''
  };
  entry.metaSource = 'PKZ-INFO';
}

// ---------------------------------------------------------------------------
// ComicInfo.xml 元数据：PKZ/CBZ/ZIP 通用（找到就解析，找不到回退文件名）
// ---------------------------------------------------------------------------
function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ''; }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseComicInfoXml(xml) {
  const text = String(xml || '').replace(/^\uFEFF/, '');
  const pick = (tag) => {
    // 兼容 <ComicInfo:Title> 这类带命名空间的标签
    const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'i');
    const m = text.match(re);
    return m ? decodeXmlEntities(m[1].replace(/<[^>]+>/g, '').trim()) : '';
  };
  const info = {
    title: pick('Title'),
    series: pick('Series'),
    volume: pick('Volume'),
    number: pick('Number'),
    writer: pick('Writer'),
    penciller: pick('Penciller'),
    summary: pick('Summary')
  };
  if (!info.title && !info.series && !info.writer && !info.volume && !info.number) return null;
  return info;
}

function comicInfoRank(name) {
  const lower = String(name).toLowerCase();
  if (lower === 'comicinfo.xml') return 0;                 // ZIP 根目录
  if (lower === 'comicinfo/comicinfo.xml') return 1;       // ComicInfo 目录
  return 2;                                                // 其他子目录
}

// 在 ZIP 中央目录里找 ComicInfo.xml，根目录优先，其次 ComicInfo/ComicInfo.xml
function findComicInfoEntry(zipPath) {
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return resolve(null);
      const found = [];
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        resolve(value);
      };
      zipfile.on('error', () => finish(null));
      zipfile.on('entry', (entry) => {
        const name = String(entry.fileName || '').replace(/\\/g, '/');
        if (!name.endsWith('/') && name.split('/').pop().toLowerCase() === 'comicinfo.xml') {
          found.push(name);
        }
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        found.sort((a, b) => comicInfoRank(a) - comicInfoRank(b));
        finish(found[0] || null);
      });
      zipfile.readEntry();
    });
  });
}

// 读取单个 ZIP 条目为文本（限制大小，避免异常归档占用过多内存）
function readZipEntryText(zipPath, entryName, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return resolve(null);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        resolve(value);
      };
      zipfile.on('error', () => finish(null));
      zipfile.on('entry', (entry) => {
        const name = String(entry.fileName || '').replace(/\\/g, '/');
        if (name !== entryName) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2) return finish(null);
          const chunks = [];
          let size = 0;
          stream.on('data', (chunk) => {
            if (size >= maxBytes) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const take = buf.slice(0, maxBytes - size);
            chunks.push(take);
            size += take.length;
          });
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            let text;
            if (buf[0] === 0xFF && buf[1] === 0xFE) text = buf.toString('utf16le');
            else text = buf.toString('utf8');
            finish(text);
          });
          stream.on('error', () => finish(null));
        });
      });
      zipfile.on('end', () => finish(null));
      zipfile.readEntry();
    });
  });
}

async function readComicInfo(zipPath) {
  try {
    const name = await findComicInfoEntry(zipPath);
    if (!name) return null;
    const xml = await readZipEntryText(zipPath, name);
    return xml ? parseComicInfoXml(xml) : null;
  } catch (e) {
    return null;
  }
}

// 将 ComicInfo 字段映射到书籍记录：Series + Volume 作为书名，Writer 作为作者
function applyComicInfo(entry, info) {
  if (!info) return;
  const series = info.series || '';
  const volume = info.volume || info.number || '';
  if (series) entry.title = volume ? `${series} 第${volume}卷` : series;
  else if (info.title) entry.title = info.title;
  if (volume) entry.volume = String(volume);
  if (info.writer) entry.author = info.writer;
  entry.comicInfo = info;
  entry.metaSource = 'ComicInfo.xml';
}

async function makeMangaEntry(abs, name) {
  const ext = path.extname(abs).toLowerCase();
  const entry = {
    path: abs,
    name: name || path.basename(abs),
    size: 0,
    mtime: 0,
    type: 'manga',
    sourceType: 'zip',
    archiveType: ext.replace('.', ''),
    pageCount: 0,
    coverPath: null,
    unsupported: false,
    invalidZip: false
  };
  if (MANGA_UNSUPPORTED_EXTS.has(ext)) {
    entry.unsupported = true;
  } else {
    try {
      const st = await fs.promises.stat(abs);
      entry.size = st.size;
      entry.mtime = st.mtimeMs;
      let images = [];
      if (ext === '.pkz') {
        // PKZ 优先读 PKZ-INFO（UUID 页序 + 元数据）；没有清单时按普通 ZIP 兼容
        const pkz = await readPkzArchive(abs);
        if (pkz && pkz.pages.length) {
          images = pkz.pages;
          entry.pkzEncoded = !!pkz.encoded;
          applyPkzInfo(entry, pkz.info, pkz.cover);
        } else {
          images = await listZipImages(abs);
          if (images.length) {
            const info = await readComicInfo(abs);
            if (info) applyComicInfo(entry, info);
          }
        }
      } else {
        images = await listZipImages(abs);
        if (images.length) {
          const info = await readComicInfo(abs);
          if (info) applyComicInfo(entry, info);
        }
      }
      entry.pageCount = images.length;
      entry.coverPath = entry.coverPath || (images[0] ? images[0].name : null);
      if (!images.length) entry.invalidZip = true;
    } catch (e) {
      // 中央目录读取失败：PKZ/CBZ/ZIP 损坏或并非 ZIP 容器
      entry.pageCount = 0;
      entry.coverPath = null;
      entry.invalidZip = true;
    }
  }
  entry.mangaId = mangaIdFor(abs);
  registerMangaBook(entry);
  return entry;
}

async function makeMangaFolderEntry(abs) {
  const images = await listFolderImages(abs);
  if (images.length < MIN_MANGA_IMAGES) return null;
  const st = await fs.promises.stat(abs).catch(() => null);
  const entry = {
    path: abs,
    name: path.basename(abs),
    size: 0,
    mtime: st ? st.mtimeMs : 0,
    type: 'manga',
    sourceType: 'folder',
    pageCount: images.length,
    coverPath: images[0].name,
    unsupported: false
  };
  entry.mangaId = mangaIdFor(abs);
  registerMangaBook(entry);
  return entry;
}

function isInsidePath(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// PKZ 条目：读取、按需 XOR 0xAA 解码，并用文件头嗅探真实 MIME
async function servePkzZipEntry(zipPath, entryName) {
  const raw = await readZipEntryBuffer(zipPath, entryName);
  if (!raw) return new Response('未找到图片', { status: 404 });
  let data = raw;
  let mime = sniffImageMime(data);
  if (!mime) {
    const decoded = xorAaBuffer(raw);
    const decodedMime = sniffImageMime(decoded);
    if (decodedMime) {
      data = decoded;
      mime = decodedMime;
    }
  }
  if (!mime) mime = 'application/octet-stream';
  return new Response(data, {
    headers: {
      'Content-Type': mime,
      'Content-Length': String(data.length),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    }
  });
}

// 流式读取 ZIP 中的单个图片条目（不整体解压）；PKZ 走解码路径
function streamZipEntry(zipPath, entryName) {
  if (isPkzPath(zipPath)) return servePkzZipEntry(zipPath, entryName);
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return resolve(new Response('无法打开 ZIP', { status: 500 }));
      let settled = false;
      const fail = (status) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        resolve(new Response('未找到图片', { status }));
      };
      zipfile.on('error', () => fail(500));
      zipfile.on('entry', (entry) => {
        if (String(entry.fileName) === entryName) {
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2) return fail(500);
            settled = true;
            const rs = new ReadableStream({
              start(controller) {
                stream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
                stream.on('end', () => {
                  try { zipfile.close(); } catch (_) {}
                  controller.close();
                });
                stream.on('error', (e) => {
                  try { zipfile.close(); } catch (_) {}
                  controller.error(e);
                });
              }
            });
            resolve(new Response(rs, {
              headers: {
                'Content-Type': mimeForImage(entryName),
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
              }
            }));
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', () => fail(404));
      zipfile.readEntry();
    });
  });
}

// manga://folder/<bookId>/<相对路径>  或  manga://zip/<bookId>/<条目名>
async function handleMangaProtocol(request) {
  try {
    const u = new URL(request.url);
    const kind = u.hostname;
    const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const bookId = segs[0];
    const rel = segs.slice(1).join('/');
    if (!bookId || !rel) return new Response('Bad request', { status: 400 });

    const entry = mangaRegistry.get(bookId);
    if (!entry) return new Response('Not found', { status: 404 });
    if (entry.sourceType !== kind) return new Response('Forbidden', { status: 403 });
    const pkz = isPkzPath(entry.path);
    if (pkz && rel.toLowerCase() === 'pkz-info') {
      return new Response('Forbidden', { status: 403 });
    }
    if (!pkz && (!isImageFileName(rel) || isIgnoredMangaPath(rel))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (pkz && isIgnoredMangaPath(rel)) {
      return new Response('Forbidden', { status: 403 });
    }

    if (kind === 'folder') {
      const abs = path.resolve(entry.path, rel);
      if (!isInsidePath(abs, entry.path)) return new Response('Forbidden', { status: 403 });
      if (!isPathAllowed(abs)) return new Response('Forbidden', { status: 403 });
      const data = await fs.promises.readFile(abs);
      return new Response(data, {
        headers: {
          'Content-Type': mimeForImage(rel),
          'Content-Length': String(data.length),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        }
      });
    }

    if (kind === 'zip') {
      return await streamZipEntry(entry.path, rel);
    }
    return new Response('Bad request', { status: 400 });
  } catch (e) {
    return new Response('Internal error', { status: 500 });
  }
}

function registerMangaProtocol() {
  protocol.handle('manga', handleMangaProtocol);
}

// ---------------------------------------------------------------------------
// 递归扫描文件夹：只返回路径/文件名/大小/mtime，不解析 EPUB 内容。
// 默认最大深度 5，忽略隐藏目录与 node_modules（任意层级）。
// ---------------------------------------------------------------------------
async function scanFolder(folderPath, maxDepth = 5) {
  const results = [];
  const root = norm(folderPath);
  // 本次扫描的“书单”归属：书库文件夹根路径。子目录里的书也归到这个根书单。
  const sourceFolder = root;

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return; // 目录不可读则跳过
    }
    const directImages = [];
    for (const ent of entries) {
      // 忽略隐藏目录和 node_modules
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          await walk(full, depth + 1);
        } else if (ent.isFile()) {
          const lower = ent.name.toLowerCase();
          if (lower.endsWith('.epub') || lower.endsWith('.txt')) {
            const st = await fs.promises.stat(full);
            results.push({
              path: norm(full),
              name: ent.name,
              size: st.size,
              mtime: st.mtimeMs,
              type: lower.endsWith('.epub') ? 'epub' : 'txt',
              sourceFolder
            });
          } else {
            const ext = path.extname(lower);
            if (MANGA_ZIP_EXTS.has(ext) || MANGA_UNSUPPORTED_EXTS.has(ext)) {
              // ZIP / CBZ 漫画；CBR / RAR 标记为暂不支持
              const entry = await makeMangaEntry(norm(full), ent.name);
              entry.sourceFolder = sourceFolder;
              results.push(entry);
            } else if (isImageFileName(ent.name) && !isIgnoredMangaPath(ent.name)) {
              directImages.push(ent.name);
            }
          }
        }
      } catch (e) {
        // 单个条目失败不影响整体扫描
      }
    }
    // 目录内直接包含 ≥3 张图片 → 视为一本漫画（子目录各自成卷）
    if (directImages.length >= MIN_MANGA_IMAGES) {
      try {
        const entry = await makeMangaFolderEntry(norm(dir));
        if (entry) {
          entry.sourceFolder = sourceFolder;
          results.push(entry);
        }
      } catch (e) { /* 忽略 */ }
    }
  }

  await walk(root, 1);
  return results;
}

// ---------------------------------------------------------------------------
// 读取 TXT：先读头部做编码检测，再读全文解码。
// 与 read-epub 一样做白名单校验，拒绝任意路径读取。
// forcedEncoding 为 'auto' 或具体编码（utf-8 / utf-16le / gbk / gb18030 / big5）。
// ---------------------------------------------------------------------------
async function readTxtInternal(bookPath, forcedEncoding) {
  if (typeof bookPath !== 'string' || !bookPath.trim()) throw new Error('无效的路径参数');
  const abs = norm(bookPath);
  if (path.extname(abs).toLowerCase() !== '.txt') throw new Error('仅支持读取 .txt 文件');
  if (!isPathAllowed(abs)) throw new Error('拒绝读取：该文件不在书库白名单内');

  const st = await fs.promises.stat(abs);
  if (!st.isFile()) throw new Error('不是有效文件');
  if (st.size === 0) return { ok: false, code: 'EMPTY', error: '文件为空' };
  if (st.size > MAX_TXT_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      error: `文件过大（${(st.size / 1024 / 1024).toFixed(1)} MB），超过 250 MB 上限，无法打开`
    };
  }

  // 先读取前 64KB 用于编码检测（大文件不必为检测单独读全文）
  const headLen = Math.min(st.size, 64 * 1024);
  const head = Buffer.alloc(headLen);
  const fh = await fs.promises.open(abs, 'r');
  try {
    await fh.read(head, 0, headLen, 0);
  } finally {
    await fh.close();
  }

  // 再按检测结果读取全文并解码
  const buf = await fs.promises.readFile(abs);
  let encoding = forcedEncoding;
  let uncertain = false;
  if (!encoding || encoding === 'auto') {
    const d = detectEncoding(head);
    encoding = d.encoding;
    uncertain = d.uncertain;
  }
  const decoded = decodeBuffer(buf, encoding);

  return {
    ok: true,
    text: decoded.text,
    encoding: decoded.encoding,
    uncertain: !!uncertain || !!decoded.uncertain,
    size: st.size,
    mtime: st.mtimeMs,
    large: st.size > LARGE_TXT_BYTES
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    title: '轻小说阅读器',
    backgroundColor: '#17181c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// IPC 注册（全部返回结构化错误，不让主进程崩溃）
// ---------------------------------------------------------------------------
function registerIpc() {
  // 选择文件夹
  ipcMain.handle('select-folder', async () => {
    try {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择书库文件夹（EPUB / TXT）',
        properties: ['openDirectory']
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      return { ok: true, path: norm(res.filePaths[0]) };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 扫描文件夹（不传参数则扫描全部已登记文件夹）
  ipcMain.handle('scan-folders', async (_e, payload) => {
    try {
      let targets = [];
      if (Array.isArray(payload)) targets = payload;
      else if (payload && Array.isArray(payload.paths)) targets = payload.paths;
      else targets = store.get('folders', []).map((f) => f.path);

      const books = [];
      for (const t of targets) {
        const list = await scanFolder(t);
        for (const b of list) allowedPaths.add(b.path);
        books.push(...list);
      }
      return { ok: true, books };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 读取书库配置（含书籍元数据缓存与进度数据）
  ipcMain.handle('get-library', () => {
    const books = store.get('books', []).map((b) => {
      if (!b || typeof b !== 'object') return b;
      // 兼容旧数据：补齐 isPinned 布尔字段与 sourceFolder 书单归属
      const out = { ...b, isPinned: !!b.isPinned };
      // 兼容旧数据：sourceFolder 不在已登记文件夹内时，归一到最近的已登记根目录
      if (typeof out.path === 'string') {
        const registered = store.get('folders', []).some(
          (f) => f && typeof f.path === 'string' && normKey(f.path) === normKey(out.sourceFolder)
        );
        if (out.sourceFolder !== '__single_imports__' && !registered) {
          out.sourceFolder = inferSourceFolder(out.path);
        }
      }
      if (out.type === 'manga' && typeof out.path === 'string') {
        const id = registerMangaBook(out);
        out.mangaId = id || out.mangaId;
      }
      return out;
    });
    return {
      ok: true,
      folders: store.get('folders', []),
      books,
      recent: store.get('recent', []),
      bookData: store.get('bookData', {})
    };
  });

  // 保存书库配置（类型校验）
  ipcMain.handle('save-library', (_e, payload) => {
    try {
      if (!payload || typeof payload !== 'object') throw new Error('参数必须是对象');
      if (Array.isArray(payload.folders)) store.set('folders', payload.folders);
      if (Array.isArray(payload.books)) {
        // 保存时补齐/归一化 sourceFolder，确保左侧书单筛选与记录一致
        const folders = store.get('folders', []);
        const isRegistered = (sf) => sf === '__single_imports__' ||
          folders.some((f) => f && typeof f.path === 'string' && normKey(f.path) === normKey(sf));
        const books = payload.books.map((b) => {
          if (!b || typeof b !== 'object' || typeof b.path !== 'string') return b;
          if (b.sourceFolder && isRegistered(b.sourceFolder)) return b;
          return { ...b, sourceFolder: inferSourceFolder(b.path) };
        });
        store.set('books', books);
        for (const b of books) {
          if (!b || typeof b.path !== 'string') continue;
          allowedPaths.add(norm(b.path));
          if (b.type === 'manga') registerMangaBook(b);
        }
      }
      if (Array.isArray(payload.recent)) store.set('recent', payload.recent);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // ------------------------------------------------------------------
  // 读取 EPUB 文件内容（关键安全点：白名单校验 + 扩展名校验）。
  // 返回 Uint8Array（Buffer 经 IPC 序列化后在渲染进程表现为 Uint8Array），
  // 渲染进程再转换为 ArrayBuffer 交给 epub.js。
  // ------------------------------------------------------------------
  ipcMain.handle('read-epub', async (_e, bookPath) => {
    try {
      if (typeof bookPath !== 'string' || !bookPath.trim()) throw new Error('无效的路径参数');
      const abs = norm(bookPath);
      if (path.extname(abs).toLowerCase() !== '.epub') throw new Error('仅支持读取 .epub 文件');
      if (!isPathAllowed(abs)) throw new Error('拒绝读取：该文件不在书库白名单内');

      const data = await fs.promises.readFile(abs);
      return { ok: true, data, size: data.length, path: abs };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 读取 TXT（自动检测编码，返回解码后的纯文本）
  ipcMain.handle('read-txt', async (_e, bookPath) => {
    try {
      return await readTxtInternal(bookPath, 'auto');
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 读取 TXT（手动指定编码，用于乱码时重试）
  ipcMain.handle('read-txt-raw', async (_e, bookPath, encoding) => {
    try {
      if (typeof encoding !== 'string' || !encoding.trim()) throw new Error('无效的编码参数');
      return await readTxtInternal(bookPath, encoding);
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // TXT 章节解析缓存（按规范化路径存；mtime/size/encoding 变化时渲染进程会使其失效）
  ipcMain.handle('get-txt-cache', (_e, bookPath) => {
    try {
      if (typeof bookPath !== 'string' || !bookPath.trim()) throw new Error('参数错误');
      const key = norm(bookPath);
      const all = store.get('txtCache', {});
      return { ok: true, data: all[key] || null };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  ipcMain.handle('set-txt-cache', (_e, bookPath, data) => {
    try {
      if (typeof bookPath !== 'string' || !bookPath.trim()) throw new Error('参数错误');
      const key = norm(bookPath);
      const all = store.get('txtCache', {});
      all[key] = data || null;
      store.set('txtCache', all);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 读取单本书进度/书签
  ipcMain.handle('get-book-data', (_e, bookPath) => {
    const key = typeof bookPath === 'string' ? norm(bookPath) : '';
    const all = store.get('bookData', {});
    return { ok: true, key, data: key ? (all[key] || null) : null };
  });

  // 保存单本书进度/书签
  ipcMain.handle('set-book-data', (_e, payload) => {
    try {
      if (!payload || typeof payload !== 'object' || typeof payload.key !== 'string' || !payload.key) {
        throw new Error('参数错误');
      }
      const key = norm(payload.key);
      const all = store.get('bookData', {});
      all[key] = payload.data || {};
      store.set('bookData', all);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 读取设置
  ipcMain.handle('get-settings', () => ({ ok: true, settings: store.get('settings', {}) }));

  // 保存设置
  ipcMain.handle('set-settings', (_e, s) => {
    try {
      if (!s || typeof s !== 'object') throw new Error('参数错误');
      store.set('settings', s);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 在资源管理器中显示文件
  ipcMain.handle('show-in-folder', (_e, p) => {
    try {
      const abs = norm(p);
      if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在' };
      shell.showItemInFolder(abs);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 选择单个/多个文件（EPUB / TXT / ZIP / CBZ）加入书库
  ipcMain.handle('open-epub-file', async () => {
    try {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '打开文件（EPUB / TXT / 漫画）',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '电子书 / 漫画', extensions: ['epub', 'txt', 'zip', 'cbz', 'pkz'] },
          { name: 'EPUB 电子书', extensions: ['epub'] },
          { name: 'TXT 文本', extensions: ['txt'] },
          { name: '漫画 (ZIP/CBZ/PKZ)', extensions: ['zip', 'cbz', 'pkz'] }
        ]
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };

      const books = [];
      for (const fp of res.filePaths) {
        const abs = norm(fp);
        try {
          const ext = path.extname(abs).toLowerCase();
          if (ext === '.epub' || ext === '.txt') {
            const st = await fs.promises.stat(abs);
            if (!st.isFile()) continue;
            allowedPaths.add(abs);
            books.push({
              path: abs,
              name: path.basename(abs),
              size: st.size,
              mtime: st.mtimeMs,
              type: ext === '.txt' ? 'txt' : 'epub',
              sourceFolder: '__single_imports__'
            });
          } else if (MANGA_ZIP_EXTS.has(ext) || MANGA_UNSUPPORTED_EXTS.has(ext)) {
            const st = await fs.promises.stat(abs);
            if (!st.isFile()) continue;
            allowedPaths.add(abs);
            const entry = await makeMangaEntry(abs, path.basename(abs));
            entry.sourceFolder = '__single_imports__';
            books.push(entry);
          }
        } catch (e) { /* 跳过无法读取的文件 */ }
      }
      return { ok: true, books };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 移除书库文件夹（仅移除记录，绝不删除源文件）
  ipcMain.handle('remove-folder', (_e, folderPath) => {
    try {
      const key = normKey(folderPath);
      const folders = store.get('folders', []).filter((f) => normKey(f.path) !== key);
      store.set('folders', folders);
      return { ok: true, folders };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 从书库移除单本书（仅移除记录，绝不删除源文件）
  ipcMain.handle('remove-book', (_e, bookPath) => {
    try {
      const key = normKey(bookPath);
      const books = store.get('books', []).filter((b) => normKey(b.path) !== key);
      store.set('books', books);
      return { ok: true, books };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 拖拽文件/文件夹注册（路径来自渲染进程 webUtils.getPathForFile）
  ipcMain.handle('register-dropped-files', async (_e, files) => {
    try {
      if (!Array.isArray(files)) throw new Error('参数错误');
      const books = [];
      for (const raw of files) {
        if (typeof raw !== 'string') continue;
        const abs = norm(raw);
        try {
          const st = await fs.promises.stat(abs);
          if (st.isFile()) {
            const ext = path.extname(abs).toLowerCase();
            if (ext === '.epub' || ext === '.txt') {
              allowedPaths.add(abs);
              books.push({
                path: abs,
                name: path.basename(abs),
                size: st.size,
                mtime: st.mtimeMs,
                type: ext === '.txt' ? 'txt' : 'epub'
              });
            } else if (MANGA_ZIP_EXTS.has(ext) || MANGA_UNSUPPORTED_EXTS.has(ext)) {
              allowedPaths.add(abs);
              books.push(await makeMangaEntry(abs, path.basename(abs)));
            }
          } else if (st.isDirectory()) {
            // 拖入的目录：含 ≥3 张图片时按漫画文件夹加入
            const entry = await makeMangaFolderEntry(abs);
            if (entry) {
              entry.sourceFolder = '__single_imports__';
              allowedPaths.add(abs);
              books.push(entry);
            }
          }
        } catch (e) { /* 跳过 */ }
      }
      return { ok: true, books };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 选择图片文件夹作为漫画导入（≥3 张图片）
  ipcMain.handle('open-manga-folder', async () => {
    try {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择漫画图片文件夹',
        properties: ['openDirectory']
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      const abs = norm(res.filePaths[0]);
      const entry = await makeMangaFolderEntry(abs);
      if (!entry) {
        return { ok: false, error: '该文件夹中可识别的图片少于 3 张，无法作为漫画导入' };
      }
      entry.sourceFolder = '__single_imports__';
      allowedPaths.add(abs);
      return { ok: true, book: entry };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 获取漫画页列表（ZIP 只读中央目录；返回自然排序后的图片条目）
  ipcMain.handle('get-manga-pages', async (_e, bookPath) => {
    try {
      if (typeof bookPath !== 'string' || !bookPath.trim()) throw new Error('无效的路径参数');
      const abs = norm(bookPath);
      const ext = path.extname(abs).toLowerCase();
      // 即使书籍记录尚未落盘，也直接拒绝 CBR/RAR，避免把它当文件夹扫描
      if (MANGA_UNSUPPORTED_EXTS.has(ext)) {
        return { ok: false, code: 'UNSUPPORTED', error: '暂不支持 CBR/RAR，请先转换为 CBZ/ZIP' };
      }
      let book = store.get('books', []).find((b) => b && b.type === 'manga' && normKey(b.path) === normKey(abs));
      if (!book) {
        if (!isPathAllowed(abs)) throw new Error('该漫画不在书库白名单内');
        book = { path: abs, type: 'manga' };
      }
      if (book.unsupported) {
        return { ok: false, code: 'UNSUPPORTED', error: '暂不支持 CBR/RAR，请先转换为 CBZ/ZIP' };
      }
      if (book.invalidZip) {
        return { ok: false, code: 'INVALID', error: '漫画文件已损坏或不含可读图片（PKZ/CBZ/ZIP）' };
      }
      const sourceType = book.sourceType === 'zip' || MANGA_ZIP_EXTS.has(ext) ? 'zip' : 'folder';
      const mangaId = registerMangaBook({ ...book, sourceType, path: abs }) || mangaIdFor(abs);

      if (sourceType === 'folder') {
        if (!isPathAllowed(abs)) throw new Error('拒绝读取：该文件夹不在书库白名单内');
        const pages = await listFolderImages(abs);
        if (!pages.length) return { ok: false, code: 'EMPTY', error: '该文件夹没有可用图片' };
        return {
          ok: true,
          sourceType,
          mangaId,
          pages,
          count: pages.length,
          large: pages.some((p) => p.size > MANGA_LARGE_IMAGE_BYTES)
        };
      }

      const st = await fs.promises.stat(abs);
      let pages;
      if (isPkzPath(abs)) {
        // 真实 PKZ：按 PKZ-INFO 的 chapters/pictures 顺序取页；无清单时回退普通 ZIP
        const pkz = await readPkzArchive(abs);
        if (pkz && pkz.pages.length) {
          pages = pkz.pages;
        } else {
          pages = await listZipImages(abs);
        }
      } else {
        pages = await listZipImages(abs);
      }
      if (!pages.length) return { ok: false, code: 'EMPTY', error: 'ZIP 中没有可用图片' };
      const large = st.size > MANGA_LARGE_ZIP_BYTES ||
        pages.length > MANGA_MAX_ENTRIES ||
        pages.some((p) => p.size > MANGA_LARGE_IMAGE_BYTES);
      return { ok: true, sourceType, mangaId, pages, count: pages.length, large, totalBytes: st.size };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 检查白名单内文件是否存在（用于清理失效书籍记录，仅返回存在性，不返回内容）
  ipcMain.handle('stat-book', async (_e, bookPath) => {
    try {
      if (typeof bookPath !== 'string') throw new Error('参数错误');
      const abs = norm(bookPath);
      if (!isPathAllowed(abs)) return { ok: true, exists: false };
      const st = await fs.promises.stat(abs);
      return { ok: true, exists: st.isFile(), size: st.size, mtime: st.mtimeMs };
    } catch (e) {
      return { ok: true, exists: false };
    }
  });

  // 应用信息
  ipcMain.handle('get-app-info', () => ({
    ok: true,
    version: app.getVersion(),
    userData: app.getPath('userData'),
    platform: process.platform,
    arch: process.arch
  }));
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.example.lightnovelreader');
  Menu.setApplicationMenu(null); // 移除默认菜单栏
  hydrateAllowedPaths();
  hydrateMangaRegistry();
  registerMangaProtocol();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
