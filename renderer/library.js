// library.js
// 书库视图：文件夹列表、书籍网格/列表渲染、类型分区（全部/EPUB/TXT）、搜索、
// 以及 EPUB 元数据（书名/作者/封面）懒加载队列。TXT 不解析封面，使用统一占位封面。

(function () {
  'use strict';

  const Library = {
    searchQuery: '',
    typeFilter: 'all',      // all | epub | txt | manga
    sourceFilter: 'all',    // all | '__single_imports__' | 书库文件夹路径
    viewMode: 'grid',       // grid | list
    pageMode: 'scroll',     // scroll | paginated
    pageSize: 50,           // 20 | 50 | 100
    page: 1,                // 当前页码（从 1 开始）
    queue: [],
    running: 0,
    concurrency: 2,         // 同时最多解析 2 本，避免同时解析全部 EPUB 卡死

    // 路径 / 类型工具
    normKey(p) {
      return String(p || '').replace(/\\/g, '/').toLowerCase();
    },
    baseName(p) {
      const parts = String(p || '').replace(/\\/g, '/').split('/');
      return parts[parts.length - 1] || p;
    },
    dirOf(p) {
      const s = String(p || '').replace(/\\/g, '/');
      const i = s.lastIndexOf('/');
      return i >= 0 ? s.slice(0, i) : s;
    },
    extOf(p) {
      const s = String(p || '').toLowerCase();
      const i = s.lastIndexOf('.');
      return i >= 0 ? s.slice(i) : '';
    },
    // 兼容旧数据：没有 type 字段的书按扩展名推断
    bookType(b) {
      if (!b) return 'epub';
      if (b.type === 'txt' || b.type === 'epub' || b.type === 'manga') return b.type;
      const ext = this.extOf(b.path);
      if (ext === '.txt') return 'txt';
      if (ext === '.zip' || ext === '.cbz' || ext === '.pkz' || ext === '.cbr' || ext === '.rar') return 'manga';
      return 'epub';
    },
    titleOf(b) {
      if (b && b.title) return b.title;
      const name = (b && (b.name || this.baseName(b.path))) || '';
      return name.replace(/\.(epub|txt|zip|cbz|pkz|cbr|rar)$/i, '');
    },
    escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    },
    formatSize(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    },
    formatDate(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      if (isNaN(d.getTime())) return '';
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    },

    // ---------- 左侧书单 / 分类导航 ----------
    renderFolders() {
      const list = document.getElementById('folders-list');
      const allBtn = document.getElementById('source-all');
      const singleBtn = document.getElementById('source-single');
      const allCount = document.getElementById('source-all-count');
      const singleCount = document.getElementById('source-single-count');
      const folders = App.state.folders || [];
      const books = App.state.books || [];

      // 选择的文件夹被移除时自动回到“全部书籍”
      if (this.sourceFilter !== 'all' && this.sourceFilter !== '__single_imports__') {
        const exists = folders.some((f) => this.normKey(f.path) === this.normKey(this.sourceFilter));
        if (!exists) this.sourceFilter = 'all';
      }

      if (allCount) allCount.textContent = String(books.length);
      if (singleCount) {
        singleCount.textContent = String(books.filter((b) => (b.sourceFolder || '') === '__single_imports__').length);
      }
      if (allBtn) allBtn.classList.toggle('active', this.sourceFilter === 'all');
      if (singleBtn) singleBtn.classList.toggle('active', this.sourceFilter === '__single_imports__');

      if (!list) return;
      if (!folders.length) {
        list.innerHTML = '<li class="folders-empty muted">尚未添加书库文件夹</li>';
        return;
      }
      list.innerHTML = '';
      for (const f of folders) {
        const li = document.createElement('li');
        li.className = 'source-item folder-source';
        li.dataset.source = f.path;
        const active = this.sourceFilter !== 'all' &&
          this.sourceFilter !== '__single_imports__' &&
          this.normKey(this.sourceFilter) === this.normKey(f.path);
        li.classList.toggle('active', active);
        const count = books.filter((b) => this.normKey(b.sourceFolder) === this.normKey(f.path)).length;
        const name = f.name || this.baseName(f.path);
        li.innerHTML =
          '<span class="source-icon">📁</span>' +
          `<span class="source-name" title="${this.escapeHtml(f.path)}">${this.escapeHtml(name)}</span>` +
          `<span class="source-count">${count}</span>` +
          '<button class="btn btn-icon folder-remove" title="移除（不删除源文件）">✕</button>';
        li.addEventListener('click', (e) => {
          if (e.target.closest('.folder-remove')) return;
          this.setSourceFilter(f.path);
        });
        li.querySelector('.folder-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          App.removeFolder(f.path);
        });
        list.appendChild(li);
      }
    },

    // ---------- 二级过滤：类型分区 ----------
    updateTypeTabs() {
      document.querySelectorAll('#type-tabs .type-tab').forEach((el) => {
        el.classList.toggle('active', el.dataset.type === this.typeFilter);
      });
    },

    setTypeFilter(type) {
      const t = (type === 'epub' || type === 'txt' || type === 'manga') ? type : 'all';
      if (this.typeFilter === t) return;
      this.typeFilter = t;
      App.state.settings.libraryTypeFilter = t;
      App.saveSettings();
      this.updateTypeTabs();
      this.page = 1;
      this.renderBooks(true);
    },

    // ---------- 一级过滤：左侧书单 ----------
    setSourceFilter(filter) {
      let next = filter;
      if (next !== 'all' && next !== '__single_imports__') {
        const folder = (App.state.folders || []).find(
          (f) => this.normKey(f.path) === this.normKey(next)
        );
        if (!folder) return;
        next = folder.path;
      }
      if (this.sourceFilter === next) return;
      this.sourceFilter = next;
      this.page = 1;
      App.state.settings.librarySourceFilter = next;
      App.saveSettings();
      this.renderFolders();
      this.renderBooks(true);
    },

    // ---------- 书籍渲染（置顶 + 分页） ----------
    renderBooks(resetScroll = false) {
      const container = document.getElementById('books-container');
      const empty = document.getElementById('empty-state');
      const emptyTitle = document.getElementById('empty-title');
      const emptyHint = document.getElementById('empty-hint');
      const countEl = document.getElementById('books-count');
      if (!container) return;

      // 切分类/搜索/翻页时回到顶部；普通重渲染（如元数据回填）保持位置
      const prevTop = resetScroll ? 0 : container.scrollTop;
      container.classList.toggle('grid', this.viewMode === 'grid');
      container.classList.toggle('list', this.viewMode === 'list');

      // 一级过滤：左侧书单（全部 / 具体文件夹 / 单本导入）
      let books = App.state.books.filter((b) => {
        if (this.sourceFilter === 'all') return true;
        const src = b.sourceFolder || (App.inferSourceFolder ? App.inferSourceFolder(b.path) : '__single_imports__');
        return this.normKey(src) === this.normKey(this.sourceFilter);
      });

      // 二级过滤：顶部类型 Tab（与左侧书单 AND）
      if (this.typeFilter !== 'all') {
        books = books.filter((b) => this.bookType(b) === this.typeFilter);
      }

      // 搜索：书名 / 作者 / 文件名
      const q = this.searchQuery.trim().toLowerCase();
      if (q) {
        books = books.filter((b) =>
          `${this.titleOf(b)} ${b.author || ''} ${b.name || ''}`.toLowerCase().includes(q)
        );
      }

      // 排序：置顶书籍永远最前，其余按加入时间倒序
      books.sort((a, b) => {
        const pa = a.isPinned ? 1 : 0;
        const pb = b.isPinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return (b.addedAt || 0) - (a.addedAt || 0);
      });

      // 分页切片：严格按 [start, end) 截断；totalPages 由过滤后的总数计算
      const pageSize = Math.max(1, Number(this.pageSize) || 20);
      const total = books.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      this.page = Math.min(Math.max(1, Number(this.page) || 1), totalPages);
      const start = (this.page - 1) * pageSize;
      const end = Math.min(start + pageSize, total);
      const pageBooks = this.pageMode === 'paginated' ? books.slice(start, end) : books;

      // 空状态（区分「书库为空」与「筛选/搜索无结果」）
      if (empty) {
        if (!App.state.books.length) {
          empty.classList.remove('hidden');
          if (emptyTitle) emptyTitle.textContent = '书库还是空的';
          if (emptyHint) emptyHint.textContent = '导入包含 EPUB / TXT / 漫画的文件夹，或直接打开 / 拖入文件';
        } else if (!total) {
          empty.classList.remove('hidden');
          if (this.sourceFilter !== 'all' && !this.searchQuery.trim() && this.typeFilter === 'all') {
            if (emptyTitle) emptyTitle.textContent = '该分类下还没有书籍';
            if (emptyHint) emptyHint.textContent = '试试选择“全部书籍”或导入新的文件';
          } else {
            if (emptyTitle) emptyTitle.textContent = '没有匹配的书籍';
            if (emptyHint) emptyHint.textContent = '试试切换书单 / 类型标签或清空搜索关键词';
          }
        } else {
          empty.classList.add('hidden');
        }
      }

      container.innerHTML = '';
      const frag = document.createDocumentFragment();
      let pinnedSeen = false;
      let dividerInserted = false;
      for (const b of pageBooks) {
        if (b.isPinned) pinnedSeen = true;
        // 置顶区与非置顶区之间插入视觉分割线
        if (!b.isPinned && pinnedSeen && !dividerInserted) {
          const divider = document.createElement('div');
          divider.className = 'pinned-divider';
          divider.textContent = '置顶';
          frag.appendChild(divider);
          dividerInserted = true;
        }
        frag.appendChild(this.createCard(b));
      }
      container.appendChild(frag);
      container.scrollTop = prevTop;

      // 规避 Chromium 滚动网格偶发漏绘最后一行：
      // DOM 中已是 20 张卡，但首屏可能只合成 18 张，直到下一次样式变更才补画。
      // 用一次 translateZ 合成层刷新，确保第一页第 4 行两张卡立即绘制。
      requestAnimationFrame(() => {
        container.style.willChange = 'transform';
        container.style.transform = 'translateZ(0)';
        requestAnimationFrame(() => {
          container.style.transform = '';
          container.style.willChange = '';
        });
      });

      if (countEl) countEl.textContent = `共 ${total} 本书`;
      this.updatePager(total, totalPages);

      // 懒加载：EPUB 且（缺书名 或 从未成功解析过元数据）的书排队
      const pending = books.filter((b) => this.bookType(b) === 'epub' && (!b.title || !b.metaMtime) && !b._parsed && !b._queued);
      this.enqueueMetadata(pending);
    },

    // 分页器状态：仅在分页模式显示；首页禁用“上一页”，末页禁用“下一页”
    updatePager(total, totalPages) {
      const pager = document.getElementById('books-pager');
      const prev = document.getElementById('btn-page-prev');
      const next = document.getElementById('btn-page-next');
      const ind = document.getElementById('page-indicator');
      if (!pager) return;
      const on = this.pageMode === 'paginated';
      pager.classList.toggle('hidden', !on);
      if (!on) return;
      if (ind) ind.textContent = `${this.page} / ${totalPages}`;
      if (prev) prev.disabled = this.page <= 1;
      if (next) next.disabled = this.page >= totalPages;
    },

    createCard(b) {
      const card = document.createElement('div');
      card.className = 'book-card';
      card.dataset.path = b.path;
      card.dataset.type = this.bookType(b);

      const type = this.bookType(b);
      card.classList.toggle('pinned', !!b.isPinned);
      // ZIP / CBZ / PKZ 角标：PKZ 底层也是 ZIP，仅展示格式不同
      const archiveExt = this.extOf(b.path).replace('.', '').toUpperCase();
      const format = type === 'manga' && b.sourceType === 'zip'
        ? (archiveExt || String(b.archiveType || 'ZIP').toUpperCase())
        : '';
      const formatBadge = format
        ? `<span class="book-format-badge format-${format.toLowerCase()}">${format}</span>`
        : '';
      const progress = App.getBookProgress(b.path);
      const progressHtml = (progress != null && progress > 0)
        ? `<div class="book-progress"><div class="book-progress-bar" style="width:${Math.max(0, Math.min(100, progress))}%"></div></div>`
        : '';
      const progressText = (progress != null && progress > 0)
        ? `<div class="book-progress-text muted">已读 ${Math.round(progress)}%</div>`
        : '';

      let coverHtml;
      let mangaCover = false;
      if (type === 'txt') {
        coverHtml = '<div class="book-cover placeholder txt-cover">TXT</div>';
      } else if (type === 'manga') {
        if (b.invalidZip) {
          coverHtml = '<div class="book-cover placeholder invalid-cover">损坏</div>';
        } else if (b.unsupported) {
          coverHtml = '<div class="book-cover placeholder cbr-cover">CBR</div>';
        } else {
          const url = window.MangaUtil ? window.MangaUtil.buildUrl(b, b.coverPath) : null;
          if (url) {
            coverHtml = `<img class="book-cover" src="${url}" alt="封面" loading="lazy" data-manga-cover="1" />`;
            mangaCover = true;
          } else {
            coverHtml = '<div class="book-cover placeholder manga-cover">漫画</div>';
          }
        }
      } else if (b.cover) {
        coverHtml = `<img class="book-cover" src="${b.cover}" alt="封面" loading="lazy" />`;
      } else {
        coverHtml = '<div class="book-cover placeholder">📖</div>';
      }

      const badgeText = type === 'manga' ? (b.unsupported ? 'CBR' : '漫画') : (type === 'txt' ? 'TXT' : 'EPUB');
      const badge = `<span class="book-type-badge type-${type}">${badgeText}</span>`;
      const title = this.titleOf(b);
      card.title = title || '';
      const pinIcon = b.isPinned ? '<span class="book-pin-icon" title="已置顶">📌</span>' : '';
      const author = b.author || (type === 'txt' ? '未知作者' : type === 'manga' ? '漫画' : '—');
      // TXT 显示大小/修改时间；漫画显示卷/话、页数与格式
      const volText = b.volume
        ? (/^\d+$/.test(String(b.volume)) ? `第 ${b.volume} 卷` : String(b.volume))
        : '';
      const volumeText = volText ? `${this.escapeHtml(volText)} · ` : '';
      const chapterText = b.chapter ? `${this.escapeHtml(String(b.chapter))} · ` : '';
      const formatLabel = b.sourceType === 'zip' ? (format || 'ZIP') : '文件夹';
      const metaLine = type === 'txt'
        ? `<div class="book-filesize muted">${this.formatSize(b.size)} · ${this.formatDate(b.mtime)}</div>`
        : type === 'manga'
          ? `<div class="book-filesize muted">${volumeText}${chapterText}${b.pageCount || 0} 页 · ${formatLabel}${b.unsupported ? ' · 暂不支持' : ''}${b.invalidZip ? ' · 文件损坏' : ''}</div>`
          : '';

      card.innerHTML =
        `<div class="book-cover-wrap">${coverHtml}${badge}${formatBadge}</div>` +
        '<div class="book-meta">' +
          `<div class="book-title" title="${this.escapeHtml(title)}">${pinIcon}${this.escapeHtml(title || '加载中…')}</div>` +
          `<div class="book-author muted" title="${this.escapeHtml(author)}">${this.escapeHtml(author)}</div>` +
          `<div class="book-file muted" title="${this.escapeHtml(b.path)}">${this.escapeHtml(b.name)}</div>` +
          metaLine +
          progressHtml + progressText +
        '</div>' +
        '<button class="btn btn-icon book-menu" title="更多操作">⋯</button>';

      if (mangaCover) {
        const img = card.querySelector('img[data-manga-cover]');
        if (img) {
          img.addEventListener('error', () => {
            img.outerHTML = '<div class="book-cover placeholder manga-cover">漫画</div>';
          });
        }
      }

      card.addEventListener('dblclick', () => App.openBook(b.path));
      card.querySelector('.book-menu').addEventListener('click', (e) => {
        e.stopPropagation();
        this.showContextMenu(e, b);
      });
      return card;
    },

    updateCard(b) {
      const card = document.querySelector(`.book-card[data-path="${CSS.escape(b.path)}"]`);
      if (!card) return;
      card.replaceWith(this.createCard(b));
    },

    // ---------- 上下文菜单 ----------
    showContextMenu(e, b) {
      this.closeContextMenu();
      const menu = document.getElementById('context-menu');
      const items = [
        { label: b.isPinned ? '📌 取消置顶' : '📌 置顶', action: () => this.togglePin(b.path) },
        { label: '打开阅读', action: () => App.openBook(b.path) },
        { label: '在资源管理器中显示', action: () => window.api.showInFolder(b.path) },
        { label: '从书库移除（不删除文件）', action: () => App.removeBook(b.path) }
      ];
      menu.innerHTML = '';
      for (const it of items) {
        const btn = document.createElement('button');
        btn.className = 'context-menu-item';
        btn.textContent = it.label;
        btn.addEventListener('click', () => { this.closeContextMenu(); it.action(); });
        menu.appendChild(btn);
      }
      menu.classList.remove('hidden');
      const rect = e.currentTarget.getBoundingClientRect();
      menu.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
      menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 150) + 'px';
    },
    closeContextMenu() {
      const menu = document.getElementById('context-menu');
      if (menu) menu.classList.add('hidden');
    },

    // ---------- 视图切换 ----------
    toggleView() {
      this.viewMode = this.viewMode === 'grid' ? 'list' : 'grid';
      document.getElementById('btn-view-toggle').textContent = this.viewMode === 'grid' ? '▦' : '☰';
      this.renderBooks(false);
    },

    // ---------- 置顶 / 分页设置 ----------
    // 从全局设置恢复书库浏览偏好（分页模式、每页数量）
    applySettings() {
      const s = App.state.settings || {};
      this.pageMode = s.libraryViewMode === 'paginated' ? 'paginated' : 'scroll';
      const size = Number(s.libraryPageSize);
      this.pageSize = [20, 50, 100].includes(size) ? size : 50;

      // 恢复左侧书单；如果保存的文件夹已被移除，则回到“全部书籍”
      const sf = s.librarySourceFilter;
      if (sf === '__single_imports__' || sf === 'all') {
        this.sourceFilter = sf;
      } else {
        const folder = (App.state.folders || []).find((f) => this.normKey(f.path) === this.normKey(sf));
        this.sourceFilter = folder ? folder.path : 'all';
      }

      // 恢复顶部类型 Tab
      this.typeFilter = ['all', 'epub', 'txt', 'manga'].includes(s.libraryTypeFilter)
        ? s.libraryTypeFilter : 'all';

      this.page = 1;
      this.updatePageModeUI();
      this.updateTypeTabs();
      this.renderFolders();
      this.renderBooks(false);
    },

    updatePageModeUI() {
      const btn = document.getElementById('btn-page-mode');
      const sel = document.getElementById('page-size-select');
      if (btn) {
        btn.textContent = this.pageMode === 'paginated' ? '滚动模式' : '分页模式';
        btn.title = this.pageMode === 'paginated' ? '切换为无限滚动' : '切换为分页模式';
        btn.classList.toggle('active', this.pageMode === 'paginated');
      }
      if (sel) {
        sel.classList.toggle('hidden', this.pageMode !== 'paginated');
        sel.value = String(this.pageSize);
      }
    },

    setPageMode(mode) {
      const m = mode === 'paginated' ? 'paginated' : 'scroll';
      if (this.pageMode === m) return;
      this.pageMode = m;
      this.page = 1;
      App.state.settings.libraryViewMode = m;
      App.saveSettings();
      this.updatePageModeUI();
      this.renderBooks(true);
    },

    setPageSize(n) {
      const size = Number(n);
      const next = [20, 50, 100].includes(size) ? size : 50;
      if (this.pageSize === next) return;
      this.pageSize = next;
      this.page = 1;
      App.state.settings.libraryPageSize = next;
      App.saveSettings();
      this.renderBooks(true);
    },

    nextPage() {
      this.page += 1;
      this.renderBooks(true);
    },

    prevPage() {
      this.page = Math.max(1, this.page - 1);
      this.renderBooks(true);
    },

    // 置顶状态直接写入书籍记录（isPinned），由 App.saveLibrary 持久化到 electron-store
    togglePin(path) {
      const b = App.findBook(path);
      if (!b) return;
      b.isPinned = !b.isPinned;
      App.scheduleSaveLibrary();
      this.renderBooks(false);
      App.toast(b.isPinned ? '已置顶（重启后仍保留）' : '已取消置顶');
    },

    // ---------- 搜索 ----------
    setSearch(q) {
      this.searchQuery = q;
      this.page = 1;
      this.renderBooks(true);
    },

    // ---------- 元数据懒加载队列（仅 EPUB） ----------
    enqueueMetadata(books) {
      for (const b of books) {
        if (!b || b._parsed || b._queued) continue;
        if (this.bookType(b) !== 'epub') { b._parsed = true; continue; }
        b._queued = true;
        this.queue.push(b);
      }
      this.pump();
    },

    async pump() {
      while (this.running < this.concurrency && this.queue.length) {
        const b = this.queue.shift();
        this.running++;
        this.processBook(b).finally(() => { this.running--; this.pump(); });
      }
    },

    async processBook(b) {
      // TXT 不需要解析：文件名即书名，作者未知
      if (this.bookType(b) === 'txt') {
        if (!b.title) b.title = this.baseName(b.path).replace(/\.txt$/i, '');
        if (!b.author) b.author = '未知作者';
        b._parsed = true;
        b._queued = false;
        this.updateCard(b);
        return;
      }
      try {
        const meta = await this.extractMetadata(b);
        if (meta) {
          if (meta.title) b.title = meta.title;
          if (meta.author) b.author = meta.author;
          if (meta.cover) { b.cover = meta.cover; b.coverMime = meta.coverMime; }
          b.metaMtime = b.mtime;
          this.updateCard(b);
          App.scheduleSaveLibrary();
        }
      } catch (err) {
        // 解析失败：使用文件名作为标题，显示占位封面，不阻塞书库
        if (!b.title) b.title = this.baseName(b.path).replace(/\.epub$/i, '');
        this.updateCard(b);
      } finally {
        b._parsed = true;
        b._queued = false;
      }
    },

    // 从 EPUB 解析书名/作者/封面。
    // 封面转成 data URL 并压缩为小尺寸 JPEG，避免 electron-store 存储过大。
    async extractMetadata(b) {
      const res = await window.api.readEpub(b.path);
      if (!res || !res.ok) throw new Error((res && res.error) || '读取失败');
      const u8 = new Uint8Array(res.data);
      const arrayBuffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

      const epub = window.ePub(arrayBuffer);
      await epub.ready;

      let title = '';
      let author = '';
      try {
        const metadata = await epub.loaded.metadata;
        title = String(metadata.title || '').trim();
        author = String(metadata.creator || '').trim();
      } catch (e) { /* 元数据解析失败 */ }

      let cover = null;
      let coverMime = null;
      try {
        // 部分 EPUB 的封面条目 media-type 非图片（如 application/octet-stream），
        // 解码/缩放可能长时间不返回；加超时，避免卡住书库元数据懒加载队列。
        const coverUrl = await this.withTimeout(Promise.resolve(epub.coverUrl()), 3000);
        if (coverUrl) {
          const dataUrl = await this.withTimeout(this.blobToDataUrl(coverUrl), 5000);
          cover = await this.withTimeout(this.resizeCover(dataUrl), 5000);
          if (cover && cover.startsWith('data:image/jpeg')) coverMime = 'image/jpeg';
          else if (cover && cover.startsWith('data:image/png')) coverMime = 'image/png';
          else coverMime = 'image';
        }
      } catch (e) { /* 封面解析失败或超时 */ }

      try { epub.destroy(); } catch (e) {}

      return {
        title: title || this.baseName(b.path).replace(/\.epub$/i, ''),
        author: author || '未知作者',
        cover, coverMime
      };
    },

    withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
      ]);
    },

    async blobToDataUrl(url) {
      if (!url) return null;
      if (url.startsWith('data:')) return url;
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        return await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      } catch (e) { return null; }
    },

    async resizeCover(dataUrl, maxDim = 480) {
      if (!dataUrl) return null;
      try {
        const img = await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = reject;
          im.src = dataUrl;
        });
        const w = img.naturalWidth || 1;
        const h = img.naturalHeight || 1;
        if (w <= maxDim && h <= maxDim) return dataUrl;
        const scale = maxDim / Math.max(w, h);
        const nw = Math.max(1, Math.round(w * scale));
        const nh = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = nw; canvas.height = nh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, nw, nh);
        return canvas.toDataURL('image/jpeg', 0.85);
      } catch (e) { return dataUrl; }
    },

    // ---------- 全局设置（书库页弹窗） ----------
    openGlobalSettings() {
      const overlay = document.getElementById('modal-overlay');
      const form = document.getElementById('global-settings-form');
      const info = document.getElementById('app-info');

      const themes = [
        { key: 'light', label: '浅色' },
        { key: 'dark', label: '深色' },
        { key: 'sepia', label: '护眼米色' },
        { key: 'night', label: '夜间' }
      ];
      form.innerHTML =
        '<div class="setting-group">' +
          '<div class="setting-label">界面主题</div>' +
          '<div class="theme-options">' +
            themes.map((t) =>
              `<label class="theme-option ${App.state.settings.theme === t.key ? 'active' : ''}">` +
                `<input type="radio" name="global-theme" value="${t.key}" ${App.state.settings.theme === t.key ? 'checked' : ''} />` +
                `<span>${t.label}</span></label>`
            ).join('') +
          '</div>' +
        '</div>';

      form.querySelectorAll('input[name="global-theme"]').forEach((inp) => {
        inp.addEventListener('change', () => {
          App.state.settings.theme = inp.value;
          App.applyAppTheme();
          App.saveSettings();
          form.querySelectorAll('.theme-option').forEach((o) => o.classList.remove('active'));
          inp.closest('.theme-option').classList.add('active');
        });
      });

      const ai = App.state.appInfo || {};
      info.innerHTML =
        `<div>版本：${this.escapeHtml(ai.version || '—')}</div>` +
        `<div>数据目录：${this.escapeHtml(ai.userData || '—')}</div>` +
        '<div class="muted">提示：字体大小、行距等阅读设置在打开书籍后的「设置」面板中调整。</div>';

      overlay.classList.remove('hidden');
    },
    closeGlobalSettings() {
      document.getElementById('modal-overlay').classList.add('hidden');
    }
  };

  window.Library = Library;
})();
