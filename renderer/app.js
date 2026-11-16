// app.js
// 应用主控：初始化、书库/阅读器导航、书库操作、全局事件、拖拽导入。

(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    fontSize: 110,            // 百分比
    lineHeight: 1.8,
    pageMargin: 24,           // px（正文内边距）
    fontFamily: 'system',     // system | serif | hei | kai
    theme: 'light',           // light | dark | sepia | night
    readingMode: 'paginated', // paginated | scrolled
    maxWidth: 840,            // px
    doubleColumn: false,
    txtIndent: true,          // TXT 段首缩进（两个全角空格）
    // 漫画独立设置（与 EPUB/TXT 字段隔离）
    mangaDirection: 'rtl',    // rtl 右到左 | ltr 左到右
    mangaDouble: false,
    mangaPreload: true,
    mangaBg: 'auto',          // auto | black | white | gray
    mangaFit: 'width',        // width | height | original
    // 书库浏览偏好（独立字段）
    libraryViewMode: 'scroll', // scroll | paginated
    libraryPageSize: 50,       // 20 | 50 | 100
    librarySourceFilter: 'all', // all | '__single_imports__' | 书库文件夹路径
    libraryTypeFilter: 'all'    // all | epub | txt | manga
  };

  const App = {
    state: {
      folders: [],
      books: [],
      recent: [],
      bookData: {},
      _bookDataNorm: {},
      settings: { ...DEFAULT_SETTINGS },
      currentBookPath: null,
      activeReader: null, // 'epub' | 'txt' | null
      appInfo: null
    },

    els: {},
    _saveTimer: null,
    _toastTimer: null,

    async init() {
      this.cacheEls();
      this.bindEvents();
      await this.loadLibrary();
      await this.loadSettings();
      Library.applySettings(); // 应用持久化的书库浏览偏好（分页/滚动、每页数量、书单、类型）
      // 启动时始终回到第 1 页（页码不做持久化；上次的书单/类型会保留）
      Library.page = 1;
      Library.renderBooks(true);
      await this.loadAppInfo();
      this.applyAppTheme();
      this.updateCounts();
    },

    cacheEls() {
      const ids = [
        'library-view', 'reader-view', 'folders-list', 'folders-count', 'books-container', 'books-count',
        'empty-state', 'search-input', 'btn-import-folder', 'btn-open-file', 'btn-open-manga-folder', 'btn-refresh', 'btn-view-toggle',
        'btn-settings', 'btn-back', 'reader-title-text', 'reader-author-text', 'btn-prev-chapter', 'btn-next-chapter', 'btn-toc', 'btn-bookmarks',
        'btn-search', 'btn-reader-settings', 'sidebar', 'toc-list', 'bookmark-list', 'reader-search-input',
        'search-scope-full', 'btn-do-search', 'search-result-list', 'btn-add-bookmark', 'reader-settings-form',
        'reader-loading', 'reader-error', 'viewer', 'status-percent', 'status-chapter', 'status-location',
        'txt-view',
        'manga-view',
        'context-menu', 'toast', 'modal-overlay', 'global-settings-form', 'app-info', 'btn-close-modal'
      ];
      for (const id of ids) this.els[id] = document.getElementById(id);
    },

    // ---------- 数据加载 ----------
    async loadLibrary() {
      const r = await window.api.getLibrary();
      if (r && r.ok) {
        this.state.folders = r.folders || [];
        this.state.books = r.books || [];
        // 兼容旧数据：补齐 type / sourceFolder；TXT 用文件名作为书名、作者未知
        let sourceChanged = false;
        for (const b of this.state.books) {
          // 兼容旧数据：没有 isPinned 字段时视为未置顶
          b.isPinned = !!b.isPinned;
          if (!b.type) {
            const ext = Library.extOf(b.path);
            b.type = ext === '.txt' ? 'txt'
              : (ext === '.zip' || ext === '.cbz' || ext === '.pkz' || ext === '.cbr' || ext === '.rar') ? 'manga'
                : 'epub';
          }
          if (b.type === 'txt') {
            if (!b.title) b.title = Library.baseName(b.path).replace(/\.txt$/i, '');
            if (!b.author) b.author = '未知作者';
          } else if (b.type === 'manga') {
            if (!b.title) b.title = Library.baseName(b.path).replace(/\.(zip|cbz|pkz|cbr|rar)$/i, '');
            if (!b.author) b.author = '漫画';
          }
          // 旧数据 / 深层扫描：sourceFolder 必须落在已登记书库文件夹内；
          // 不在其中的（例如记录成更深一层子目录）归一到最近的已登记根目录。
          const registered = (this.state.folders || []).some(
            (f) => f && Library.normKey(f.path) === Library.normKey(b.sourceFolder)
          );
          if (b.sourceFolder !== '__single_imports__' && !registered) {
            b.sourceFolder = this.inferSourceFolder(b.path);
            sourceChanged = true;
          }
        }
        if (sourceChanged) this.scheduleSaveLibrary();
        this.state.recent = r.recent || [];
        this.state.bookData = r.bookData || {};
        this.state._bookDataNorm = {};
        for (const k in this.state.bookData) {
          this.state._bookDataNorm[Library.normKey(k)] = this.state.bookData[k];
        }
      }
      Library.renderFolders();
      Library.renderBooks();
    },

    // 旧数据 / 新导入兜底：按已登记文件夹的最长前缀反推 sourceFolder
    inferSourceFolder(bookPath) {
      const key = Library.normKey(bookPath);
      let best = null;
      for (const f of this.state.folders || []) {
        if (!f || typeof f.path !== 'string') continue;
        const fk = Library.normKey(f.path).replace(/\/+$/, '');
        if (key === fk || key.startsWith(fk + '/')) {
          if (!best || fk.length > Library.normKey(best).length) best = f.path;
        }
      }
      return best || '__single_imports__';
    },

    async loadSettings() {
      const r = await window.api.getSettings();
      if (r && r.ok && r.settings && typeof r.settings === 'object') {
        this.state.settings = { ...DEFAULT_SETTINGS, ...r.settings };
      }
    },

    async loadAppInfo() {
      const r = await window.api.getAppInfo();
      if (r && r.ok) this.state.appInfo = r;
    },

    // ---------- 持久化 ----------
    scheduleSaveLibrary() {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.saveLibrary(), 600);
    },
    async saveLibrary() {
      try {
        await window.api.saveLibrary({
          folders: this.state.folders,
          books: this.state.books,
          recent: this.state.recent
        });
      } catch (e) { console.error(e); }
    },
    async saveSettings() {
      try { await window.api.setSettings(this.state.settings); } catch (e) { console.error(e); }
    },

    updateBookData(path, data) {
      this.state.bookData[path] = data;
      this.state._bookDataNorm[Library.normKey(path)] = data;
    },

    getBookProgress(path) {
      const key = Library.normKey(path);
      const d = this.state.bookData[path] || this.state._bookDataNorm[key];
      if (d && typeof d.percent === 'number') return d.percent;
      return null;
    },

    // ---------- 主题 ----------
    applyAppTheme() {
      document.body.className = 'theme-' + (this.state.settings.theme || 'light');
    },

    // ---------- 导航 ----------
    showLibrary() {
      ['reader-view', 'txt-view', 'manga-view'].forEach((id) => {
        const el = this.els[id];
        if (el) el.classList.remove('active');
      });
      this.els['library-view'].classList.add('active');
      this.state.currentBookPath = null;
      this.state.activeReader = null;
    },

    showReader() {
      this.els['library-view'].classList.remove('active');
      ['txt-view', 'manga-view'].forEach((id) => { const el = this.els[id]; if (el) el.classList.remove('active'); });
      this.els['reader-view'].classList.add('active');
      this.state.activeReader = 'epub';
    },

    showTxtReader() {
      this.els['library-view'].classList.remove('active');
      ['reader-view', 'manga-view'].forEach((id) => { const el = this.els[id]; if (el) el.classList.remove('active'); });
      this.els['txt-view'].classList.add('active');
      this.state.activeReader = 'txt';
    },

    showMangaReader() {
      this.els['library-view'].classList.remove('active');
      ['reader-view', 'txt-view'].forEach((id) => { const el = this.els[id]; if (el) el.classList.remove('active'); });
      this.els['manga-view'].classList.add('active');
      this.state.activeReader = 'manga';
    },

    async openBook(path) {
      const book = this.findBook(path);
      if (!book) { this.toast('未找到该书'); return; }
      const type = Library.bookType(book);
      if (type === 'manga' && book.unsupported) {
        this.toast('暂不支持 CBR/RAR，请先转换为 CBZ/ZIP');
        return;
      }
      if (type === 'manga' && book.invalidZip) {
        this.toast('漫画文件已损坏或不含可读图片（PKZ/CBZ/ZIP）');
        return;
      }
      this.state.currentBookPath = path;
      this.state.recent = [path, ...this.state.recent.filter((p) => Library.normKey(p) !== Library.normKey(path))].slice(0, 20);
      this.scheduleSaveLibrary();
      if (type === 'txt') {
        this.showTxtReader();
        await TxtReader.open(path, book);
      } else if (type === 'manga') {
        this.showMangaReader();
        await MangaReader.open(path, book);
      } else {
        this.showReader();
        await Reader.open(path, book);
      }
    },

    async goBack() {
      if (this.state.activeReader === 'txt') await TxtReader.close();
      else if (this.state.activeReader === 'manga') await MangaReader.close();
      else await Reader.close();
      this.showLibrary();
      Library.renderBooks();
      this.updateCounts();
    },

    findBook(path) {
      const key = Library.normKey(path);
      return this.state.books.find((b) => Library.normKey(b.path) === key) || null;
    },

    // ---------- 书库操作 ----------
    async importFolder() {
      const r = await window.api.selectFolder();
      if (!r || !r.ok) return;
      const folderPath = r.path;
      if (this.state.folders.some((f) => Library.normKey(f.path) === Library.normKey(folderPath))) {
        this.toast('该文件夹已在书库中');
        return;
      }
      const scan = await window.api.scanFolders([folderPath]);
      if (!scan || !scan.ok) { this.toast('扫描失败：' + ((scan && scan.error) || '未知错误')); return; }
      this.state.folders.push({ path: folderPath, name: Library.baseName(folderPath), addedAt: Date.now() });
      const added = this.mergeScannedBooks(scan.books || [], [folderPath]);
      await this.saveLibrary();
      Library.renderFolders();
      Library.renderBooks();
      this.updateCounts();
      Library.enqueueMetadata(added);
      this.toast(`已导入文件夹，发现 ${(scan.books || []).length} 个文件（EPUB/TXT/漫画）`);
    },

    async openFile() {
      const r = await window.api.openEpubFile();
      if (!r || !r.ok) return;
      await this.addEpubFiles(r.books || [], { openIfSingle: (r.books || []).length === 1 });
    },

    // 选择一个图片文件夹作为漫画导入（主进程校验 ≥3 张图片）
    async openMangaFolder() {
      const r = await window.api.openMangaFolder();
      if (!r || !r.ok) {
        if (r && !r.canceled) this.toast(r.error || '导入漫画文件夹失败');
        return;
      }
      const added = this.mergeScannedBooks([r.book], null);
      await this.saveLibrary();
      Library.renderFolders();
      Library.renderBooks();
      this.updateCounts();
      Library.enqueueMetadata(added);
      if (added.length) this.openBook(added[0].path);
    },

    async addEpubFiles(entries, opts = {}) {
      if (!entries.length) { this.toast('未发现可导入的文件'); return; }
      const added = this.mergeScannedBooks(entries, null);
      await this.saveLibrary();
      Library.renderFolders();
      Library.renderBooks();
      this.updateCounts();
      Library.enqueueMetadata(added);
      if (opts.openIfSingle && added.length === 1) {
        this.openBook(added[0].path);
      } else {
        this.toast(`已加入 ${added.length} 本书`);
      }
    },

    // 合并扫描/拖拽得到的书籍基础信息：按规范化路径去重，更新大小/mtime。
    // 若指定了 folderPaths，则属于这些文件夹、但未出现在扫描结果中的书视为失效。
    mergeScannedBooks(entries, folderPaths) {
      const map = new Map(this.state.books.map((b) => [Library.normKey(b.path), b]));
      const added = [];

      for (const e of entries) {
        if (!e || !e.path) continue;
        const key = Library.normKey(e.path);
        const existing = map.get(key);
        if (existing) {
          const changed = existing.mtime !== e.mtime || existing.size !== e.size;
          existing.size = e.size;
          existing.mtime = e.mtime;
          if (e.type) existing.type = e.type;
          if (e.sourceFolder) existing.sourceFolder = e.sourceFolder;
          else if (!existing.sourceFolder) existing.sourceFolder = this.inferSourceFolder(existing.path);
          if (e.type === 'manga') {
            existing.sourceType = e.sourceType || existing.sourceType || 'folder';
            existing.mangaId = e.mangaId || existing.mangaId;
            existing.pageCount = typeof e.pageCount === 'number' ? e.pageCount : (existing.pageCount || 0);
            existing.coverPath = e.coverPath !== undefined ? e.coverPath : existing.coverPath;
            existing.unsupported = !!e.unsupported;
            existing.invalidZip = !!e.invalidZip;
            existing.archiveType = e.archiveType || existing.archiveType || Library.extOf(e.path).replace('.', '');
            if (e.title) existing.title = e.title;
            if (e.author) existing.author = e.author;
            if (e.volume) existing.volume = e.volume;
            if (e.chapter) existing.chapter = e.chapter;
            else if (e.pkzInfo) existing.chapter = '';
            if (e.comicInfo) existing.comicInfo = e.comicInfo;
            if (e.pkzInfo) existing.pkzInfo = e.pkzInfo;
            if (!existing.title) existing.title = Library.baseName(e.path).replace(/\.(zip|cbz|pkz|cbr|rar)$/i, '');
            if (!existing.author) existing.author = '漫画';
          }
          if (changed) {
            existing.cover = null;
            existing.metaMtime = null;
            // 漫画标题/作者来自 ComicInfo 或扫描结果，不因 mtime 变化清空
            if (existing.type !== 'manga') { existing.title = ''; existing.author = ''; }
            added.push(existing);
          }
        } else {
          const ext = Library.extOf(e.path);
          const type = e.type || (ext === '.txt' ? 'txt'
            : (ext === '.zip' || ext === '.cbz' || ext === '.pkz' || ext === '.cbr' || ext === '.rar') ? 'manga'
              : 'epub');
          const nb = {
            path: e.path,
            name: e.name || Library.baseName(e.path),
            size: e.size || 0,
            mtime: e.mtime || 0,
            type,
            title: type === 'txt' ? Library.baseName(e.path).replace(/\.txt$/i, '') : '',
            author: type === 'txt' ? '未知作者' : '',
            cover: null, coverMime: null, metaMtime: null,
            addedAt: Date.now(),
            isPinned: false,
            sourceFolder: e.sourceFolder || (folderPaths && folderPaths[0]) || this.inferSourceFolder(e.path)
          };
          if (type === 'manga') {
            nb.title = e.title || Library.baseName(e.path).replace(/\.(zip|cbz|pkz|cbr|rar)$/i, '');
            nb.author = e.author || '漫画';
            nb.sourceType = e.sourceType || ((ext === '.zip' || ext === '.cbz' || ext === '.pkz') ? 'zip' : 'folder');
            nb.archiveType = e.archiveType || ext.replace('.', '');
            nb.invalidZip = !!e.invalidZip;
            nb.mangaId = e.mangaId || '';
            nb.pageCount = typeof e.pageCount === 'number' ? e.pageCount : 0;
            nb.coverPath = e.coverPath || null;
            nb.unsupported = !!e.unsupported;
            nb.volume = e.volume || '';
            nb.chapter = e.chapter || '';
            nb.comicInfo = e.comicInfo || null;
            nb.pkzInfo = e.pkzInfo || null;
          }
          map.set(key, nb);
          this.state.books.push(nb);
          added.push(nb);
        }
      }

      // 文件夹内失效清理
      if (folderPaths && folderPaths.length) {
        const folderKeys = new Set(folderPaths.map((p) => Library.normKey(p)));
        this.state.books = this.state.books.filter((b) => {
          const key = Library.normKey(b.path);
          const inFolder = Array.from(folderKeys).some((fk) => key.startsWith(fk + '/'));
          if (!inFolder) return true;
          return map.has(key);
        });
      }
      return added;
    },

    async refreshLibrary() {
      this.toast('正在刷新书库…');
      const scanned = [];
      for (const f of this.state.folders) {
        const r = await window.api.scanFolders([f.path]);
        if (r && r.ok) scanned.push(...(r.books || []));
      }
      const scannedMap = new Map(scanned.map((b) => [Library.normKey(b.path), b]));
      const folderKeys = this.state.folders.map((f) => Library.normKey(f.path));

      const next = [];
      const touched = [];
      for (const b of this.state.books) {
        const key = Library.normKey(b.path);
        if (scannedMap.has(key)) {
          const s = scannedMap.get(key);
          const changed = b.mtime !== s.mtime || b.size !== s.size;
          const nb = { ...b, size: s.size, mtime: s.mtime };
          if (s.type) nb.type = s.type;
          if (s.sourceFolder) nb.sourceFolder = s.sourceFolder;
          else if (!nb.sourceFolder) nb.sourceFolder = this.inferSourceFolder(nb.path);
          if (s.type === 'manga') {
            nb.sourceType = s.sourceType || nb.sourceType;
            nb.mangaId = s.mangaId || nb.mangaId;
            nb.pageCount = s.pageCount || 0;
            nb.coverPath = s.coverPath || null;
            nb.unsupported = !!s.unsupported;
            nb.invalidZip = !!s.invalidZip;
            nb.archiveType = s.archiveType || nb.archiveType || Library.extOf(s.path).replace('.', '');
            if (s.title) nb.title = s.title;
            if (s.author) nb.author = s.author;
            if (s.volume) nb.volume = s.volume;
            if (s.chapter) nb.chapter = s.chapter;
            else if (s.pkzInfo) nb.chapter = '';
            if (s.comicInfo) nb.comicInfo = s.comicInfo;
            if (s.pkzInfo) nb.pkzInfo = s.pkzInfo;
          }
          if (changed) {
            nb.cover = null;
            nb.metaMtime = null;
            // 漫画标题/作者来自 ComicInfo，不因 mtime 变化清空
            if (nb.type !== 'manga') { nb.title = ''; nb.author = ''; }
            touched.push(nb);
          }
          next.push(nb);
          scannedMap.delete(key);
        } else {
          const inFolder = folderKeys.some((fk) => key.startsWith(fk + '/'));
          if (inFolder) continue; // 文件夹内的书已消失 → 清理失效记录
          next.push(b);            // 单文件导入的书先保留，下面再检查是否存在
        }
      }
      for (const s of scannedMap.values()) {
        const ext = Library.extOf(s.path);
        const type = s.type || (ext === '.txt' ? 'txt'
          : (ext === '.zip' || ext === '.cbz' || ext === '.pkz' || ext === '.cbr' || ext === '.rar') ? 'manga'
            : 'epub');
        const nb = {
          path: s.path, name: s.name, size: s.size, mtime: s.mtime, type,
          title: type === 'txt' ? Library.baseName(s.path).replace(/\.txt$/i, '') : '',
          author: type === 'txt' ? '未知作者' : '',
          cover: null, coverMime: null, metaMtime: null,
          addedAt: Date.now(),
          isPinned: false,
          sourceFolder: s.sourceFolder || this.inferSourceFolder(s.path)
        };
        if (type === 'manga') {
          nb.title = s.title || Library.baseName(s.path).replace(/\.(zip|cbz|pkz|cbr|rar)$/i, '');
          nb.author = s.author || '漫画';
          nb.sourceType = s.sourceType || ((ext === '.zip' || ext === '.cbz' || ext === '.pkz') ? 'zip' : 'folder');
          nb.archiveType = s.archiveType || ext.replace('.', '');
          nb.invalidZip = !!s.invalidZip;
          nb.mangaId = s.mangaId || '';
          nb.pageCount = s.pageCount || 0;
          nb.coverPath = s.coverPath || null;
          nb.unsupported = !!s.unsupported;
          nb.volume = s.volume || '';
          nb.chapter = s.chapter || '';
          nb.comicInfo = s.comicInfo || null;
          nb.pkzInfo = s.pkzInfo || null;
        }
        next.push(nb);
        touched.push(nb);
      }

      // 单文件导入的书：检查文件是否仍存在，失效则移除记录
      const standalone = next.filter((b) => !folderKeys.some((fk) => Library.normKey(b.path).startsWith(fk + '/')));
      for (const b of standalone) {
        const st = await window.api.statBook(b.path);
        if (st && st.ok && st.exists === false) {
          const i = next.indexOf(b);
          if (i >= 0) next.splice(i, 1);
        }
      }

      this.state.books = next;
      await this.saveLibrary();
      Library.renderFolders();
      Library.renderBooks();
      this.updateCounts();
      Library.enqueueMetadata(touched);
      this.toast('刷新完成');
    },

    async removeFolder(folderPath) {
      const r = await window.api.removeFolder(folderPath);
      if (r && r.ok) {
        this.state.folders = r.folders;
        const key = Library.normKey(folderPath);
        this.state.books = this.state.books.filter((b) => {
          const bk = Library.normKey(b.path);
          return !(bk === key || bk.startsWith(key + '/'));
        });
        // 当前书单正好是被移除的文件夹时，回到“全部书籍”
        if (Library.sourceFilter !== 'all' && Library.sourceFilter !== '__single_imports__' &&
            Library.normKey(Library.sourceFilter) === key) {
          Library.sourceFilter = 'all';
          this.state.settings.librarySourceFilter = 'all';
          this.saveSettings();
        }
        await this.saveLibrary();
        Library.renderFolders();
        Library.renderBooks(true);
        this.updateCounts();
        this.toast('已移除书库文件夹（源文件未删除）');
      }
    },

    async removeBook(path) {
      const r = await window.api.removeBook(path);
      if (r && r.ok) {
        this.state.books = this.state.books.filter((b) => Library.normKey(b.path) !== Library.normKey(path));
        await this.saveLibrary();
        Library.renderFolders();
        Library.renderBooks();
        this.updateCounts();
        this.toast('已从书库移除（源文件未删除）');
      }
    },

    // ---------- UI ----------
    updateCounts() {
      // books-count 由 Library.renderBooks 按“当前书单 + 类型 + 搜索”计算；
      // 这里只更新文件夹数量，避免把筛选后的数量覆盖成全部书籍数。
      if (this.els['folders-count']) this.els['folders-count'].textContent = `${this.state.folders.length} 个`;
    },

    toast(msg) {
      const t = this.els['toast'];
      t.textContent = msg;
      t.classList.remove('hidden');
      t.classList.add('show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { t.classList.remove('show'); t.classList.add('hidden'); }, 2400);
    },

    // ---------- 事件绑定 ----------
    bindEvents() {
      this.els['btn-import-folder'].addEventListener('click', () => this.importFolder());
      this.els['btn-open-file'].addEventListener('click', () => this.openFile());
      this.els['btn-open-manga-folder'].addEventListener('click', () => this.openMangaFolder());
      this.els['btn-refresh'].addEventListener('click', () => this.refreshLibrary());
      this.els['btn-view-toggle'].addEventListener('click', () => Library.toggleView());

      // 左侧书单：全部 / 单本导入（文件夹项由 Library.renderFolders 动态绑定）
      const sourceAll = document.getElementById('source-all');
      if (sourceAll) sourceAll.addEventListener('click', () => Library.setSourceFilter('all'));
      const sourceSingle = document.getElementById('source-single');
      if (sourceSingle) sourceSingle.addEventListener('click', () => Library.setSourceFilter('__single_imports__'));

      // 书库：分页模式切换、每页数量、上一页/下一页
      const btnPageMode = document.getElementById('btn-page-mode');
      if (btnPageMode) {
        btnPageMode.addEventListener('click', () => {
          Library.setPageMode(Library.pageMode === 'paginated' ? 'scroll' : 'paginated');
        });
      }
      const pageSizeSelect = document.getElementById('page-size-select');
      if (pageSizeSelect) {
        pageSizeSelect.addEventListener('change', (e) => Library.setPageSize(e.target.value));
      }
      const btnPagePrev = document.getElementById('btn-page-prev');
      if (btnPagePrev) btnPagePrev.addEventListener('click', () => Library.prevPage());
      const btnPageNext = document.getElementById('btn-page-next');
      if (btnPageNext) btnPageNext.addEventListener('click', () => Library.nextPage());
      this.els['btn-settings'].addEventListener('click', () => Library.openGlobalSettings());
      this.els['btn-close-modal'].addEventListener('click', () => Library.closeGlobalSettings());
      this.els['modal-overlay'].addEventListener('click', (e) => { if (e.target === this.els['modal-overlay']) Library.closeGlobalSettings(); });

      this.els['btn-back'].addEventListener('click', () => this.goBack());
      this.els['btn-prev-chapter'].addEventListener('click', () => Reader.prevChapter());
      this.els['btn-next-chapter'].addEventListener('click', () => Reader.nextChapter());
      this.els['btn-toc'].addEventListener('click', () => Reader.toggleSidebar('toc'));
      this.els['btn-bookmarks'].addEventListener('click', () => Reader.toggleSidebar('bookmarks'));
      this.els['btn-search'].addEventListener('click', () => Reader.toggleSidebar('search'));
      this.els['btn-reader-settings'].addEventListener('click', () => Reader.toggleSidebar('settings'));
      const btnReadingMode = document.getElementById('btn-reading-mode');
      if (btnReadingMode) btnReadingMode.addEventListener('click', () => Reader.toggleReadingMode());
      this.els['btn-add-bookmark'].addEventListener('click', () => Reader.addBookmark());
      this.els['btn-do-search'].addEventListener('click', () => Reader.doSearch());
      this.els['reader-search-input'].addEventListener('keydown', (e) => { if (e.key === 'Enter') Reader.doSearch(); });

      this.els['search-input'].addEventListener('input', (e) => Library.setSearch(e.target.value));

      // 类型分区标签（全部 / EPUB / TXT），切换不刷新页面
      const typeTabs = document.getElementById('type-tabs');
      if (typeTabs) {
        typeTabs.addEventListener('click', (e) => {
          const btn = e.target.closest('.type-tab');
          if (btn) Library.setTypeFilter(btn.dataset.type);
        });
      }

      // 键盘：按当前打开的阅读器分发
      document.addEventListener('keydown', (e) => {
        if (this.els['reader-view'].classList.contains('active')) Reader.handleKeydown(e);
        else if (this.els['txt-view'] && this.els['txt-view'].classList.contains('active')) TxtReader.handleKeydown(e);
        else if (this.els['manga-view'] && this.els['manga-view'].classList.contains('active')) MangaReader.handleKeydown(e);
      });

      // 拖拽 .epub 到窗口打开
      window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        const paths = [];
        for (const f of files) {
          const p = window.api.getPathForFile ? window.api.getPathForFile(f) : null;
          if (p) paths.push(p);
        }
        if (!paths.length) return;
        // 交给主进程统一识别：EPUB / TXT / ZIP / CBZ / CBR / 图片文件夹
        window.api.registerDroppedFiles(paths).then((r) => {
          if (r && r.ok && (r.books || []).length) {
            this.addEpubFiles(r.books || [], { openIfSingle: (r.books || []).length === 1 });
          } else {
            this.toast('未识别到可导入的文件（EPUB/TXT/ZIP/CBZ/图片文件夹）');
          }
        });
      });

      // 点击空白处关闭右键菜单
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.context-menu')) Library.closeContextMenu();
      });
    }
  };

  window.App = App;
  window.DEFAULT_SETTINGS = DEFAULT_SETTINGS;

  App.init().catch((err) => console.error('初始化失败', err));
})();
