// platform/mobile/mobile-api.js
// Android / WebView 的 window.api 兼容层。
// 只使用 Web API（File/Blob/IndexedDB/TextDecoder）与可选的 Capacitor Filesystem；
// 不使用 fs / path / yauzl / electron-store。
(function () {
  'use strict';

  const DB_NAME = 'lnr-mobile';
  const DB_VERSION = 2;
  const KV = 'kv';
  const FILES = 'files';
  const LARGE_ARCHIVE = 64 * 1024 * 1024; // 64MB：超过则用 zip.js 流式
  const MAX_COVER_CACHE = 12;

  const fileCache = new Map();       // path -> File
  const txtCache = new Map();        // path -> cached text
  const sourceCache = new Map();     // book.path -> zip source
  const pageUrlCache = new Map();    // path::name -> objectURL
  const pageUrlOrder = [];

  let dbPromise = null;

  // ---------------------------------------------------------------------------
  // SAF/文件选择器：Android WebView 的原生 <input type=file> 即 SAF
  // ---------------------------------------------------------------------------
  class WebFilePicker {
    pickFiles({ accept = '.epub,.txt,.zip,.cbz,.pkz,application/epub+zip,text/plain,application/zip,application/octet-stream', multiple = true } = {}) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple !== false;
        input.tabIndex = -1;
        input.setAttribute('aria-hidden', 'true');
        // 不要用 display:none：部分 Android WebView 会拒绝打开不可见 input。
        // 用 1x1 透明元素，既不可见又能接收用户手势。
        input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none;z-index:-1;';
        document.body.appendChild(input);

        let settled = false;
        let focusTimer = null;
        const cleanup = () => {
          if (focusTimer) clearTimeout(focusTimer);
          window.removeEventListener('focus', onWindowFocus);
          input.remove();
        };
        const finish = (files) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(files);
        };
        const onWindowFocus = () => {
          // 某些 Android WebView 取消选择时不触发 change/oncancel；
          // 回到页面后短暂等待，确认没有文件就按“取消”处理，避免 Promise 永远挂起。
          setTimeout(() => {
            if (!settled) finish([]);
          }, 700);
        };

        input.onchange = () => finish(Array.from(input.files || []));
        input.oncancel = () => finish([]);
        // 选择器打开后窗口通常失焦，关闭时重新聚焦。延迟注册避免刚 append 时误触发。
        setTimeout(() => {
          if (!settled) window.addEventListener('focus', onWindowFocus, { once: true });
        }, 350);
        input.click();
      });
    }

    pickDirectory() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        document.body.appendChild(input);
        input.onchange = () => {
          const files = Array.from(input.files || []);
          input.remove();
          resolve(files);
        };
        input.oncancel = () => { input.remove(); resolve([]); };
        input.click();
      });
    }
  }

  const picker = new WebFilePicker();

  // ---------------------------------------------------------------------------
  // IndexedDB
  // ---------------------------------------------------------------------------
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function dbGet(store, key, fallback = null) {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
      req.onerror = () => resolve(fallback);
    });
  }

  async function dbPut(store, key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbDelete(store, key) {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
    });
  }

  async function dbAll(store) {
    const db = await openDB();
    return new Promise((resolve) => {
      const out = [];
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        out.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      };
      req.onerror = () => resolve(out);
    });
  }

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function extOf(name) {
    const s = String(name || '').toLowerCase();
    const i = s.lastIndexOf('.');
    return i >= 0 ? s.slice(i) : '';
  }

  function baseName(p) {
    return String(p || '').replace(/\\/g, '/').split('/').pop() || '';
  }

  function isImage(name) {
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp']
      .includes(extOf(name));
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function xorAa(bytes) {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ 0xAA;
    return out;
  }

  function parseJsonBytes(bytes) {
    try {
      const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '').trim();
      return text.startsWith('{') ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  function decodeXmlEntities(s) {
    return String(s || '')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
        try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
      })
      .replace(/&#(\d+);/g, (_, d) => {
        try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; }
      })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function parseComicInfo(xml) {
    const pick = (tag) => {
      const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'i');
      const m = String(xml).match(re);
      return m ? decodeXmlEntities(m[1].replace(/<[^>]+>/g, '').trim()) : '';
    };
    const info = {
      title: pick('Title'), series: pick('Series'), volume: pick('Volume'),
      number: pick('Number'), writer: pick('Writer')
    };
    return (info.title || info.series || info.writer || info.volume) ? info : null;
  }

  function sniffMime(bytes) {
    if (!bytes || bytes.length < 4) return 'application/octet-stream';
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
    if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 3)) === 'GIF') return 'image/gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
    return 'application/octet-stream';
  }

  function decodeText(bytes, encoding = 'auto') {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (encoding && encoding !== 'auto') {
      try { return new TextDecoder(encoding).decode(buf); } catch { /* fallback */ }
    }
    if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
    if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(buf.subarray(3));
    }
    for (const enc of ['utf-8', 'gb18030', 'big5', 'utf-16le']) {
      try {
        return new TextDecoder(enc, { fatal: true }).decode(buf);
      } catch { /* next */ }
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  // ---------------------------------------------------------------------------
  // 文件持久化：小文件 IndexedDB Blob；大文件 Native Filesystem 分块
  // ---------------------------------------------------------------------------
  function toBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }

  function nativeFilesystem() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    return (cap.Plugins && cap.Plugins.Filesystem) || null;
  }

  async function persistNativeFile(file, path) {
    const fs = nativeFilesystem();
    if (!fs) throw new Error('Filesystem 不可用');
    const safe = String(file.name || 'book.bin').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    const nativePath = `books/${uuid()}-${safe}`;
    const chunkSize = 2 * 1024 * 1024;

    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const chunk = new Uint8Array(
        await file.slice(offset, Math.min(offset + chunkSize, file.size)).arrayBuffer()
      );
      const data = toBase64(chunk);
      if (offset === 0) {
        await fs.writeFile({ path: nativePath, data, directory: 'DATA', recursive: true });
      } else {
        if (typeof fs.appendFile !== 'function') throw new Error('Filesystem.appendFile 不可用');
        await fs.appendFile({ path: nativePath, data, directory: 'DATA' });
      }
    }
    return nativePath;
  }

  async function storeFile(file, path) {
    // 大文件不常驻 fileCache：重新打开时通过 nativePath 从 Filesystem 取，
    // 避免 500MB PKZ 在 WebView 里同时保留 File/Blob 两份内存。
    if (file.size <= LARGE_ARCHIVE) fileCache.set(path, file);
    const rec = {
      name: file.name,
      size: file.size,
      mime: file.type || '',
      lastModified: file.lastModified || Date.now(),
      blob: null,
      nativePath: null
    };

    const fs = nativeFilesystem();
    if (file.__nativePath) {
      // 已由原生 FilePicker 复制到应用私有目录，避免二次复制 500MB 文件
      rec.nativePath = file.__nativePath;
    } else if (fs && file.size > LARGE_ARCHIVE) {
      try {
        rec.nativePath = await persistNativeFile(file, path);
      } catch (e) {
        // 原生分块失败时退回 Blob（可能受配额限制）
        rec.blob = file;
      }
    } else {
      rec.blob = file;
    }
    await dbPut(FILES, path, rec);
  }

  async function getFile(path) {
    if (fileCache.has(path)) return fileCache.get(path);
    const rec = await dbGet(FILES, path);
    if (!rec) return null;

    let file = null;
    if (rec.blob) {
      file = rec.blob instanceof File
        ? rec.blob
        : new File([rec.blob], rec.name, { type: rec.mime, lastModified: rec.lastModified });
    } else if (rec.nativePath) {
      const fs = nativeFilesystem();
      const cap = window.Capacitor;
      if (fs && cap) {
        const { uri } = await fs.getUri({ path: rec.nativePath, directory: 'DATA' });
        const url = cap.convertFileSrc(uri);
        const blob = await (await fetch(url)).blob();
        file = new File([blob], rec.name, { type: rec.mime, lastModified: rec.lastModified });
      }
    }
    if (file) fileCache.set(path, file);
    return file;
  }

  // ---------------------------------------------------------------------------
  // 原生文件选择器（@capawesome/capacitor-file-picker）+ 批次书单
  // ---------------------------------------------------------------------------
  function nativeCapacitor() {
    const cap = window.Capacitor;
    return cap && cap.isNativePlatform && cap.isNativePlatform() ? cap : null;
  }

  function nativeFilePicker() {
    const cap = nativeCapacitor();
    return (cap && cap.Plugins && cap.Plugins.FilePicker) || null;
  }

  function base64ToFile(data, name, mime, modifiedAt) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime || 'application/octet-stream', lastModified: modifiedAt || Date.now() });
  }

  async function nativePickedToFile(item) {
    if (!item) throw new Error('无效文件');
    if (item.data) {
      return base64ToFile(item.data, item.name, item.mimeType, item.modifiedAt);
    }
    const cap = nativeCapacitor();
    const fp = nativeFilePicker();
    const fs = nativeFilesystem();
    if (!cap || !fp || !item.path) throw new Error('原生文件路径不可用');

    const safe = String(item.name || 'book.bin').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    const target = `imports/${uuid()}-${safe}`;
    let file = null;

    try {
      if (fs && typeof fp.copyFile === 'function') {
        // 让原生层把 content:// 复制成 app 私有 file://，避免把整个文件读成 base64
        // 注意：getUri 只负责生成 URI，不会创建 imports/ 目录；必须先 mkdir。
        try {
          if (typeof fs.mkdir === 'function') {
            await fs.mkdir({ path: 'imports', directory: 'DATA', recursive: true });
          }
        } catch (mkdirError) {
          // 目录已存在时某些实现会抛错，忽略并继续 getUri
          console.warn('mkdir imports skipped:', mkdirError);
        }
        const { uri } = await fs.getUri({ path: target, directory: 'DATA' });
        await fp.copyFile({ from: item.path, to: uri, overwrite: true });
        const blob = await (await fetch(cap.convertFileSrc(uri))).blob();
        file = new File([blob], item.name, {
          type: item.mimeType || 'application/octet-stream',
          lastModified: item.modifiedAt || Date.now()
        });
        file.__nativePath = target;
      }
    } catch (e) {
      // 某些 ROM 的 content URI 不支持 copyFile，再尝试直接 fetch
      try {
        const blob = await (await fetch(item.path)).blob();
        file = new File([blob], item.name, {
          type: item.mimeType || 'application/octet-stream',
          lastModified: item.modifiedAt || Date.now()
        });
      } catch (e2) {
        throw new Error('无法读取所选文件：' + ((e2 && e2.message) || e2));
      }
    }
    return file;
  }

  async function pickNativeFiles() {
    const fp = nativeFilePicker();
    if (!fp || typeof fp.pickFiles !== 'function') throw new Error('原生文件选择器不可用');

    let result;
    try {
      result = await fp.pickFiles({ multiple: true, readData: false });
    } catch (e) {
      const err = new Error('无法打开系统文件选择器：' + ((e && e.message) || e));
      err.code = 'PICKER_OPEN_FAILED';
      err.cause = e;
      throw err;
    }

    const picked = (result && result.files) || [];
    if (!picked.length) return [];

    const files = [];
    const failed = [];
    for (const item of picked) {
      try {
        files.push(await nativePickedToFile(item));
      } catch (e) {
        console.error('read picked file failed:', item && item.name, e);
        failed.push(item && item.name ? item.name : '未知文件');
      }
    }

    if (!files.length && failed.length) {
      const err = new Error('已选中文件，但读取失败：' + failed.join('、'));
      err.code = 'FILE_READ_FAILED';
      throw err;
    }
    if (failed.length) {
      files.__warnings = failed;
      if (window.App && typeof window.App.toast === 'function') {
        setTimeout(() => window.App.toast(`${failed.length} 个文件读取失败，已导入其余文件`), 200);
      }
    }
    return files;
  }

  async function pickBookFiles() {
    const fp = nativeFilePicker();
    if (fp) {
      try {
        return await pickNativeFiles();
      } catch (e) {
        // 只有“系统选择器打不开”才回退 HTML；已经选中但读取失败时不再弹第二次选择器
        if (e && e.code === 'PICKER_OPEN_FAILED') {
          console.warn('native picker open failed, fallback to input', e);
          return picker.pickFiles();
        }
        throw e;
      }
    }
    return picker.pickFiles();
  }

  async function pickImageFiles() {
    const fp = nativeFilePicker();
    if (fp) {
      try {
        const all = await pickNativeFiles();
        return all.filter((f) => isImage(f.name));
      } catch (e) {
        if (e && e.code === 'PICKER_OPEN_FAILED') {
          console.warn('native image picker open failed, fallback to input', e);
          return picker.pickFiles({ accept: 'image/*', multiple: true });
        }
        throw e;
      }
    }
    return picker.pickFiles({ accept: 'image/*', multiple: true });
  }

  function makeBatchFolder(prefix = '手机导入') {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return {
      path: `batch://${y}${m}${day}/${uuid()}`,
      name: `${prefix} ${y}/${m}/${day} ${hh}:${mm}`,
      addedAt: Date.now(),
      batch: true
    };
  }

  async function ensureBatchFolder(folder) {
    const app = window.App;
    if (!app || !app.state || !Array.isArray(app.state.folders)) return;
    const exists = app.state.folders.some(
      (f) => String(f.path).toLowerCase() === String(folder.path).toLowerCase()
    );
    if (exists) return;
    app.state.folders.push(folder);
    try { await app.saveLibrary(); } catch (e) { /* ignore */ }
    try {
      if (window.Library) window.Library.renderFolders();
      if (app.updateCounts) app.updateCounts();
    } catch (e) { /* ignore */ }
  }

  async function importBatch(files, prefix = '手机导入') {
    if (!files || !files.length) return { ok: false, canceled: true };
    const batch = makeBatchFolder(prefix);
    const books = [];
    for (const f of files) books.push(await makeBook(f, batch.path));
    await ensureBatchFolder(batch);
    return { ok: true, books, batch, warnings: files.__warnings || [] };
  }

  // ---------------------------------------------------------------------------
  // ZIP 读取：小文件 JSZip；大文件 zip.js（BlobReader 随机读取）
  // ---------------------------------------------------------------------------
  class JSZipSource {
    constructor(file) { this.file = file; this.zip = null; this.namesList = []; }
    async open() {
      this.zip = await JSZip.loadAsync(this.file);
      this.namesList = Object.keys(this.zip.files).filter((n) => !this.zip.files[n].dir);
    }
    names() { return this.namesList; }
    async read(name) {
      const entry = this.zip.file(name);
      if (!entry) return null;
      return new Uint8Array(await entry.async('arraybuffer'));
    }
    close() { this.zip = null; }
  }

  class ZipJsSource {
    constructor(file) { this.file = file; this.reader = null; this.entries = []; }
    async open() {
      const z = window.zip;
      if (!z || !z.ZipReader || !z.BlobReader) throw new Error('zip.js 未加载');
      this.reader = new z.ZipReader(new z.BlobReader(this.file));
      this.entries = await this.reader.getEntries();
    }
    names() { return this.entries.map((e) => e.filename); }
    async read(name) {
      const entry = this.entries.find((e) => e.filename === name);
      if (!entry) return null;
      const z = window.zip;
      return new Uint8Array(await entry.getData(new z.Uint8ArrayWriter()));
    }
    close() {
      if (this.reader) this.reader.close();
      this.reader = null;
      this.entries = [];
    }
  }

  function openZipSource(file) {
    return file.size > LARGE_ARCHIVE ? new ZipJsSource(file) : new JSZipSource(file);
  }

  function collectPkzPages(info) {
    const pages = [];
    for (const comic of (info.comics || [])) {
      for (const vol of (comic.volumes || [])) {
        for (const chap of (vol.chapters || [])) {
          for (const pic of (chap.pictures || []).slice().sort((a, b) => (a.idx || 0) - (b.idx || 0))) {
            if (pic && pic.picture_path) {
              pages.push({ name: String(pic.picture_path), size: 0 });
            }
          }
        }
      }
    }
    return pages;
  }

  async function probeManga(file, ext, path) {
    const source = openZipSource(file);
    await source.open();
    const names = source.names();
    let pages = [];
    let coverPath = null;
    let title = '';
    let author = '';
    let volume = '';
    let chapter = '';

    try {
      if (ext === '.pkz') {
        const raw = names.find((n) => n.toLowerCase() === 'pkz-info');
        if (raw) {
          const bytes = await source.read(raw);
          const info = parseJsonBytes(bytes) || parseJsonBytes(xorAa(bytes));
          if (info) {
            const comic = (info.comics || [])[0] || {};
            title = comic.title || info.name || '';
            author = comic.author || info.author || '';
            const vol = (comic.volumes || [])[0] || {};
            const chap = (vol.chapters || [])[0] || {};
            volume = vol.title || '';
            const chapterTitle = chap.title || '';
            const team = comic.chinese_team || '';
            if (chapterTitle && chapterTitle !== team &&
              /第|話|话|卷|集|章|chapter|ch\.?|全彩|熟肉/i.test(chapterTitle)) {
              chapter = chapterTitle;
            }
            pages = collectPkzPages(info);
            coverPath = comic.cover_path || info.cover_path || (pages[0] && pages[0].name) || null;
          }
        }
      }

      if (!pages.length) {
        pages = names
          .filter((n) => isImage(n) && !n.split('/').some((p) => p.startsWith('.') || p === '__MACOSX'))
          .sort(naturalCompare)
          .map((n) => ({ name: n, size: 0 }));
        coverPath = pages[0] ? pages[0].name : null;
      }

      if (!title) {
        const infoName = names.find((n) => n.split('/').pop().toLowerCase() === 'comicinfo.xml');
        if (infoName) {
          const xml = new TextDecoder('utf-8').decode(await source.read(infoName));
          const info = parseComicInfo(xml);
          if (info) {
            title = info.series
              ? (info.volume ? `${info.series} 第${info.volume}卷` : info.series)
              : (info.title || '');
            author = info.writer || '';
            volume = info.volume || info.number || volume;
          }
        }
      }
    } finally {
      source.close();
    }

    return {
      title: title || file.name.replace(/\.(zip|cbz|pkz)$/i, ''),
      author: author || '漫画',
      volume,
      chapter,
      pageCount: pages.length,
      coverPath,
      pages,
      sourceType: 'zip',
      archiveType: ext.replace('.', ''),
      mangaId: path,
      invalidZip: pages.length === 0
    };
  }

  // ---------------------------------------------------------------------------
  // 书籍记录 / 导入
  // ---------------------------------------------------------------------------
  async function makeBook(file, sourceFolder, pathOverride) {
    const path = pathOverride || `web://${uuid()}/${file.name}`;
    await storeFile(file, path);
    const ext = extOf(file.name);
    const type = ext === '.txt' ? 'txt'
      : ['.epub'].includes(ext) ? 'epub'
        : ['.zip', '.cbz', '.pkz', '.cbr', '.rar'].includes(ext) ? 'manga'
          : 'epub';

    const book = {
      path,
      name: file.name,
      size: file.size,
      mtime: file.lastModified || Date.now(),
      type,
      sourceFolder,
      isPinned: false,
      addedAt: Date.now()
    };

    if (type === 'txt') {
      book.title = file.name.replace(/\.txt$/i, '');
      book.author = '未知作者';
    } else if (type === 'manga') {
      book.sourceType = 'zip';
      Object.assign(book, await probeManga(file, ext, path));
    }
    return book;
  }

  async function makeFolderManga(files, folderPath, rootName, sourceFolder = '__single_imports__') {
    const images = files.filter((f) => isImage(f.name));
    if (!images.length) return null;
    const pages = [];
    for (const f of images) {
      const rel = f.webkitRelativePath
        ? f.webkitRelativePath.split('/').slice(1).join('/') || f.name
        : f.name;
      const path = `${folderPath}/${rel}`;
      await storeFile(f, path);
      pages.push({ name: rel, size: f.size });
    }
    pages.sort((a, b) => naturalCompare(a.name, b.name));
    return {
      path: folderPath,
      name: rootName,
      size: 0,
      mtime: Date.now(),
      type: 'manga',
      sourceType: 'folder',
      archiveType: '',
      mangaId: folderPath,
      title: rootName,
      author: '漫画',
      pageCount: pages.length,
      coverPath: pages[0] ? pages[0].name : null,
      invalidZip: false,
      sourceFolder,
      isPinned: false,
      addedAt: Date.now()
    };
  }

  // ---------------------------------------------------------------------------
  // 书库读写
  // ---------------------------------------------------------------------------
  const EMPTY_LIB = { folders: [], books: [], recent: [], bookData: {} };

  async function readLibrary() {
    const lib = await dbGet(KV, 'library', null);
    const base = lib || { folders: [], books: [], recent: [] };
    const bookData = {};
    for (const row of await dbAll(KV)) {
      if (String(row.key).startsWith('book:')) {
        bookData[String(row.key).slice(5)] = row.value;
      }
    }
    return {
      folders: base.folders || [],
      books: base.books || [],
      recent: base.recent || [],
      bookData
    };
  }

  // ---------------------------------------------------------------------------
  // 移动漫画：页 Blob URL / 封面
  // ---------------------------------------------------------------------------
  async function getZipSource(book) {
    if (sourceCache.has(book.path)) return sourceCache.get(book.path);
    const file = await getFile(book.path);
    if (!file) throw new Error('漫画文件不存在');
    const source = openZipSource(file);
    await source.open();
    sourceCache.set(book.path, source);
    return source;
  }

  async function pageBytes(book, pageName) {
    if (book.sourceType === 'folder') {
      const file = await getFile(`${book.path}/${pageName}`);
      if (!file) throw new Error('页文件不存在');
      return new Uint8Array(await file.arrayBuffer());
    }
    const source = await getZipSource(book);
    const raw = await source.read(pageName);
    if (!raw) throw new Error('页条目不存在');
    return book.archiveType === 'pkz' ? xorAa(raw) : raw;
  }

  function revokePageUrls(bookPath, coverPath) {
    const prefix = bookPath + '::';
    const keep = coverPath ? `${bookPath}::${coverPath}` : null;
    for (const [key, url] of Array.from(pageUrlCache)) {
      if (!key.startsWith(prefix) || key === keep) continue;
      try { URL.revokeObjectURL(url); } catch {}
      pageUrlCache.delete(key);
    }
  }

  const MobileManga = {
    async resolvePageUrl(book, pageName) {
      const key = `${book.path}::${pageName}`;
      if (pageUrlCache.has(key)) return pageUrlCache.get(key);

      const bytes = await pageBytes(book, pageName);
      const blob = new Blob([bytes], { type: sniffMime(bytes) });
      const url = URL.createObjectURL(blob);
      pageUrlCache.set(key, url);
      pageUrlOrder.push(key);
      while (pageUrlOrder.length > MAX_COVER_CACHE * 2) {
        const old = pageUrlOrder.shift();
        const oldUrl = pageUrlCache.get(old);
        if (oldUrl) {
          try { URL.revokeObjectURL(oldUrl); } catch {}
          pageUrlCache.delete(old);
        }
      }
      return url;
    },

    async prepareCovers(books) {
      for (const b of books) {
        if (!b || b.type !== 'manga' || !b.coverPath || b.coverUrl) continue;
        try {
          b.coverUrl = await this.resolvePageUrl(b, b.coverPath);
        } catch { /* 保留占位封面 */ }
      }
      // 封面生成完后释放 ZIP 句柄，翻页时再按需打开
      for (const [path, source] of sourceCache) {
        try { source.close(); } catch {}
        sourceCache.delete(path);
      }
    },

    invalidateCover(bookPath, coverPath) {
      if (!bookPath || !coverPath) return;
      const key = `${bookPath}::${coverPath}`;
      const old = pageUrlCache.get(key);
      if (old) {
        try { URL.revokeObjectURL(old); } catch {}
        pageUrlCache.delete(key);
      }
    },

    async refreshCover(book) {
      if (!book || !book.coverPath) return null;
      this.invalidateCover(book.path, book.coverPath);
      try {
        const url = await this.resolvePageUrl(book, book.coverPath);
        book.coverUrl = url;
        const stateBook = window.App && App.findBook ? App.findBook(book.path) : null;
        if (stateBook) stateBook.coverUrl = url;
        return url;
      } catch {
        return null;
      }
    },

    closeBook(bookPath, coverPath) {
      const source = sourceCache.get(bookPath);
      if (source) {
        try { source.close(); } catch {}
        sourceCache.delete(bookPath);
      }
      revokePageUrls(bookPath, coverPath);
    }
  };
  window.MobileManga = MobileManga;

  // ---------------------------------------------------------------------------
  // window.api
  // ---------------------------------------------------------------------------
  const api = {
    __mobile: true,

    async getLibrary() {
      return { ok: true, ...(await readLibrary()) };
    },

    async saveLibrary(lib) {
      await dbPut(KV, 'library', {
        folders: lib.folders || [],
        books: lib.books || [],
        recent: lib.recent || []
      });
      return { ok: true };
    },

    async getSettings() {
      return { ok: true, settings: await dbGet(KV, 'settings', {}) };
    },
    async setSettings(settings) {
      await dbPut(KV, 'settings', settings || {});
      return { ok: true };
    },

    async getBookData(path) {
      return { ok: true, data: await dbGet(KV, `book:${path}`, null) };
    },
    async setBookData(path, data) {
      await dbPut(KV, `book:${path}`, data);
      return { ok: true };
    },

    async getTxtCache(path) {
      return { ok: true, data: txtCache.get(path) || null };
    },
    async setTxtCache(path, data) {
      txtCache.set(path, data);
      return { ok: true };
    },

    async openEpubFile() {
      const files = await pickBookFiles();
      if (!files.length) return { ok: false, canceled: true };
      return importBatch(files, '手机导入');
    },

    async selectFolder() {
      const files = await picker.pickDirectory();
      if (!files.length) return { ok: false, canceled: true };
      const root = (files[0].webkitRelativePath || files[0].name).split('/')[0] || '导入文件夹';
      const folderPath = `web://dir/${uuid()}/${root}`;
      for (const f of files) {
        const rel = f.webkitRelativePath
          ? f.webkitRelativePath.split('/').slice(1).join('/') || f.name
          : f.name;
        await storeFile(f, `${folderPath}/${rel}`);
      }
      return { ok: true, path: folderPath, name: root };
    },

    async scanFolders(paths) {
      const rows = await dbAll(FILES);
      const books = [];
      for (const row of rows) {
        const path = String(row.key);
        if (!paths.some((p) => path.startsWith(p + '/'))) continue;
        if (isImage(row.value.name)) continue;
        const file = await getFile(path);
        if (!file) continue;
        books.push(await makeBook(file, path.slice(0, path.lastIndexOf('/')), path));
      }
      return { ok: true, books };
    },

    async openMangaFolder() {
      const files = await pickImageFiles();
      if (!files.length) return { ok: false, canceled: true };
      const batch = makeBatchFolder('手机漫画');
      const book = await makeFolderManga(files, batch.path, batch.name, batch.path);
      if (!book) return { ok: false, error: '未选择可用的图片' };
      await ensureBatchFolder(batch);
      return { ok: true, book };
    },

    async readEpub(path) {
      const file = await getFile(path);
      if (!file) return { ok: false, error: '文件不存在' };
      return {
        ok: true,
        data: new Uint8Array(await file.arrayBuffer()),
        size: file.size,
        mtime: file.lastModified
      };
    },

    async readTxt(path) {
      const file = await getFile(path);
      if (!file) return { ok: false, error: '文件不存在' };
      if (!file.size) return { ok: false, code: 'EMPTY', error: '文件为空' };
      const bytes = new Uint8Array(await file.arrayBuffer());
      return {
        ok: true,
        text: decodeText(bytes, 'auto'),
        encoding: 'auto',
        size: file.size,
        mtime: file.lastModified,
        large: file.size > 10 * 1024 * 1024
      };
    },

    async readTxtRaw(path, encoding) {
      const file = await getFile(path);
      if (!file) return { ok: false, error: '文件不存在' };
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { ok: true, text: decodeText(bytes, encoding), encoding };
    },

    async getMangaPages(path) {
      const lib = await readLibrary();
      const book = (lib.books || []).find((b) => b.path === path);
      if (!book) return { ok: false, error: '漫画记录不存在' };

      if (book.sourceType === 'folder' || String(path).startsWith('web://dir/') && !book.archiveType) {
        const rows = await dbAll(FILES);
        const pages = rows
          .map((r) => String(r.key))
          .filter((p) => p.startsWith(path + '/') && isImage(p))
          .map((p) => ({ name: p.slice(path.length + 1), size: 0 }))
          .sort((a, b) => naturalCompare(a.name, b.name));
        return {
          ok: true, sourceType: 'folder', mangaId: path, pages,
          count: pages.length, large: false
        };
      }

      const file = await getFile(path);
      if (!file) return { ok: false, error: '漫画文件不存在' };
      const info = await probeManga(file, book.archiveType ? '.' + book.archiveType : extOf(file.name), path);
      return {
        ok: true,
        sourceType: 'zip',
        mangaId: path,
        pages: info.pages,
        count: info.pages.length,
        large: file.size > 500 * 1024 * 1024
      };
    },

    async statBook(path) {
      const rec = await dbGet(FILES, path, null);
      return { ok: true, exists: !!rec, size: rec?.size || 0, mtime: rec?.lastModified || 0 };
    },

    async removeBook(path) {
      await dbDelete(FILES, path);
      fileCache.delete(path);
      MobileManga.closeBook(path);
      return { ok: true };
    },

    async removeFolder(path) {
      const lib = await readLibrary();
      const key = String(path || '').toLowerCase();
      lib.folders = (lib.folders || []).filter((f) => String(f.path || '').toLowerCase() !== key);
      await dbPut(KV, 'library', {
        folders: lib.folders,
        books: lib.books || [],
        recent: lib.recent || []
      });
      return { ok: true, folders: lib.folders };
    },

    async registerDroppedFiles(paths) {
      const books = [];
      for (const path of paths) {
        const file = await getFile(path);
        if (!file) continue;
        books.push(await makeBook(file, '__single_imports__', path));
      }
      return { ok: true, books };
    },

    getPathForFile(file) {
      if (!file) return null;
      const path = `web://${uuid()}/${file.name}`;
      // 同步返回 path；实际写入在 registerDroppedFiles 前完成
      fileCache.set(path, file);
      storeFile(file, path).catch(() => {});
      return path;
    },

    async showInFolder() { return { ok: true }; },

    async getAppInfo() {
      return { ok: true, version: '1.2.0-mobile', platform: 'android', arch: 'webview' };
    },

    // 测试/原生备用：直接导入 File 数组
    async __importFiles(files, sourceFolder = '__single_imports__') {
      const books = [];
      for (const f of files) books.push(await makeBook(f, sourceFolder));
      return { ok: true, books };
    },

    async __importBatch(files, prefix = '手机导入') {
      return importBatch(files, prefix);
    }
  };

  window.api = api;
})();
