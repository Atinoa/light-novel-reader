// manga-reader.js
// 独立漫画阅读器：图片文件夹 / ZIP / CBZ。
// - 不依赖 epub.js iframe，也不复用 TXT 文本渲染
// - 图片通过自定义协议 manga:// 读取（主进程做白名单校验）
// - 预加载当前页前后各 2 页，离开窗口后 revokeObjectURL，避免内存泄漏

(function () {
  'use strict';

  const MangaUtil = {
    encodePath(p) {
      return String(p || '').split('/').map((s) => encodeURIComponent(s)).join('/');
    },
    // 生成 manga:// JSON URL：manga://folder/<bookId>/<相对路径> 或 manga://zip/<bookId>/<条目名>
    buildUrl(book, pageName) {
      if (!book || !book.mangaId || !pageName) return null;
      const kind = book.sourceType === 'zip' ? 'zip' : 'folder';
      return `manga://${kind}/${encodeURIComponent(book.mangaId)}/${MangaUtil.encodePath(pageName)}`;
    }
  };
  window.MangaUtil = MangaUtil;

  const MangaReader = {
    path: null,
    book: null,
    pages: [],
    index: 0,
    loaded: false,
    sourceType: 'folder',
    mangaId: '',
    bookmarks: [],
    sidebarPanel: null,

    // 阅读设置（与全局设置共用存储，但使用独立字段）
    direction: 'rtl',   // rtl 右到左 | ltr 左到右
    doubleMode: false,
    fit: 'width',       // width | height | original
    preload: true,
    bg: 'auto',         // auto | black | white | gray

    zoom: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    dragStart: null,
    _dragMoved: false,
    _suppressClick: false,

    urlCache: new Map(), // pageIndex -> { name, url, objectUrl, error }
    _renderToken: 0,
    _persistTimer: null,
    _lastWheel: 0,
    _resizeTimer: null,

    // ---------- 初始化 ----------
    init() {
      const on = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
      };
      on('manga-btn-back', () => App.goBack());
      on('manga-btn-prev', () => this.prev());
      on('manga-btn-next', () => this.next());
      on('manga-btn-direction', () => this.toggleDirection());
      on('manga-btn-fit-width', () => this.setFit('width'));
      on('manga-btn-fit-height', () => this.setFit('height'));
      on('manga-btn-fit-original', () => this.setFit('original'));
      on('manga-btn-toc', () => this.toggleSidebar('toc'));
      on('manga-btn-bookmarks', () => this.toggleSidebar('bookmarks'));
      on('manga-btn-settings', () => this.toggleSidebar('settings'));
      on('manga-btn-add-bookmark', () => this.addBookmark());

      const stage = document.getElementById('manga-stage');
      if (stage) {
        stage.addEventListener('click', (e) => this.onAreaClick(e));
        stage.addEventListener('dblclick', (e) => this.onDblClick(e));
        stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        stage.addEventListener('mousedown', (e) => this.onDragStart(e));
        stage.addEventListener('mousemove', (e) => this.onDragMove(e));
        stage.addEventListener('mouseup', () => this.onDragEnd());
        stage.addEventListener('mouseleave', () => this.onDragEnd());
      }

      window.addEventListener('resize', () => {
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => {
          if (this.loaded && document.getElementById('manga-view').classList.contains('active')) {
            this.render();
          }
        }, 200);
      });
    },

    // ---------- 打开 ----------
    async open(path, book) {
      this.reset();
      this.path = path;
      this.book = book;
      this.showLoading(true);
      this.hideError();
      this.setTitle(
        (book && (book.title || book.name)) || '漫画',
        book && book.unsupported ? '暂不支持' : '漫画'
      );

      if (book && book.unsupported) {
        this.showLoading(false);
        this.showError('暂不支持 CBR/RAR 格式，请先转换为 CBZ/ZIP 后再打开。');
        return;
      }

      try {
        const saved = await this.loadSavedData(path);
        const res = await window.api.getMangaPages(path);
        if (!res || !res.ok) {
          this.showLoading(false);
          this.showError((res && res.error) || '无法读取漫画');
          return;
        }
        this.pages = Array.isArray(res.pages) ? res.pages : [];
        this.sourceType = res.sourceType === 'zip' ? 'zip' : 'folder';
        this.mangaId = res.mangaId || (book && book.mangaId) || '';
        this.book = { ...book, sourceType: this.sourceType, mangaId: this.mangaId, pageCount: this.pages.length };

        if (!this.pages.length) {
          this.showLoading(false);
          this.showError('这本漫画没有可显示的图片');
          return;
        }
        if (res.large) App.toast('漫画较大，首次打开或翻页可能稍慢');

        this.applyStoredSettings();

        // 恢复页码；越界回退到最后一页
        const savedIndex = saved && typeof saved.pageIndex === 'number' ? saved.pageIndex : 0;
        let idx = Math.floor(savedIndex) || 0;
        if (idx < 0) idx = 0;
        if (idx >= this.pages.length) {
          idx = this.pages.length - 1;
          if (saved && saved.pageIndex !== undefined) App.toast('上次阅读页码超出范围，已回到最后一页');
        }
        this.index = idx;
        this.bookmarks = saved && Array.isArray(saved.bookmarks) ? saved.bookmarks : [];

        this.loaded = true;
        this.buildToc();
        this.showLoading(false);
        await this.render();
        this.renderBookmarks();
      } catch (e) {
        this.showLoading(false);
        this.showError('打开漫画失败：' + ((e && e.message) || e));
      }
    },

    reset() {
      this.revokeAll();
      this.path = null;
      this.book = null;
      this.pages = [];
      this.index = 0;
      this.loaded = false;
      this.sourceType = 'folder';
      this.mangaId = '';
      this.bookmarks = [];
      this.sidebarPanel = null;
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      const spread = document.getElementById('manga-spread');
      if (spread) { spread.innerHTML = ''; spread.style.transform = ''; }
      this.hideError();
      this.closeSidebar();
    },

    async close() {
      if (this.loaded && (App.state.currentBookPath || this.path)) {
        try { await this.persistBookData(); } catch (e) {}
      }
      this.revokeAll();
      const spread = document.getElementById('manga-spread');
      if (spread) spread.innerHTML = '';
      this.loaded = false;
    },

    revokeAll() {
      for (const [, v] of this.urlCache) {
        if (v && v.objectUrl) {
          try { URL.revokeObjectURL(v.objectUrl); } catch (e) {}
        }
      }
      this.urlCache.clear();
    },

    async loadSavedData(path) {
      let data = App.state.bookData[path] ||
        (App.state._bookDataNorm ? App.state._bookDataNorm[Library.normKey(path)] : null);
      if (!data) {
        try {
          const r = await window.api.getBookData(path);
          if (r && r.ok && r.data) data = r.data;
        } catch (e) {}
      }
      return data || null;
    },

    applyStoredSettings() {
      const s = App.state.settings || {};
      this.direction = s.mangaDirection === 'ltr' ? 'ltr' : 'rtl';
      this.doubleMode = !!s.mangaDouble;
      this.preload = s.mangaPreload !== false;
      this.bg = s.mangaBg || 'auto';
      this.fit = s.mangaFit === 'height' || s.mangaFit === 'original' ? s.mangaFit : 'width';
      this.updateDirectionButton();
    },

    // ---------- 页面加载与缓存 ----------
    pageUrl(i) {
      const p = this.pages[i];
      return p ? MangaUtil.buildUrl(this.book, p.name) : null;
    },

    async ensurePage(i) {
      if (i < 0 || i >= this.pages.length) return null;
      const cached = this.urlCache.get(i);
      if (cached) return cached;

      const name = this.pages[i].name;
      const direct = this.pageUrl(i);
      const entry = { index: i, name, url: direct, objectUrl: null, error: false };
      this.urlCache.set(i, entry);

      try {
        // 通过 fetch 走 manga:// 协议；失败时退回直接 URL（<img> 不受 CORS 限制）
        const resp = await fetch(direct);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        entry.objectUrl = URL.createObjectURL(blob);
      } catch (e) {
        entry.error = true;
      }
      return entry;
    },

    preloadAround() {
      if (!this.preload) return;
      const total = this.pages.length;
      const extra = this.doubleMode && this.canDouble() ? 1 : 0;
      for (let i = this.index - 2; i <= this.index + 2 + extra; i++) {
        if (i < 0 || i >= total || this.urlCache.has(i)) continue;
        this.ensurePage(i).catch(() => {});
      }
    },

    evict() {
      const extra = this.doubleMode && this.canDouble() ? 1 : 0;
      const min = this.index - 2;
      const max = this.index + 2 + extra;
      for (const [i, v] of this.urlCache) {
        if (i < min || i > max) {
          if (v.objectUrl) {
            try { URL.revokeObjectURL(v.objectUrl); } catch (e) {}
          }
          this.urlCache.delete(i);
        }
      }
    },

    // ---------- 渲染 ----------
    canDouble() {
      return window.innerWidth >= 900; // 窄屏自动降级为单页
    },

    async render() {
      if (!this.loaded || !this.pages.length) return;
      const token = ++this._renderToken;
      const total = this.pages.length;
      const double = this.doubleMode && this.canDouble();

      let spread;
      if (double) {
        if (this.index <= 0) {
          this.index = 0;
          spread = [0]; // 封面单独一页
        } else {
          if (this.index % 2 === 0) this.index -= 1;
          spread = [this.index, this.index + 1].filter((i) => i < total);
        }
      } else {
        this.index = Math.max(0, Math.min(total - 1, this.index));
        spread = [this.index];
      }

      const items = [];
      for (const i of spread) {
        const item = await this.ensurePage(i);
        if (token !== this._renderToken) return;
        if (item) items.push(item);
      }

      const spreadEl = document.getElementById('manga-spread');
      if (!spreadEl) return;
      spreadEl.innerHTML = '';
      spreadEl.classList.toggle('rtl', this.direction === 'rtl');
      spreadEl.style.transform = '';
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;

      for (const item of items) {
        const slot = document.createElement('div');
        slot.className = 'manga-slot';
        slot.dataset.page = String(item.index);
        if (item.objectUrl || item.url) {
          const img = document.createElement('img');
          img.className = 'manga-page';
          img.alt = item.name || '';
          img.src = item.objectUrl || item.url;
          img.loading = 'eager';
          img.decoding = 'async';
          img.draggable = false;
          img.addEventListener('error', () => this.showImageError(slot, item.index));
          slot.appendChild(img);
        } else {
          this.showImageError(slot, item.index);
        }
        spreadEl.appendChild(slot);
      }

      this.applyStageClasses();
      this.applyBackground();
      this.updateStatus();
      this.preloadAround();
      this.evict();
      this.schedulePersist();
    },

    applyStageClasses() {
      const stage = document.getElementById('manga-stage');
      if (!stage) return;
      const double = this.doubleMode && this.canDouble();
      stage.classList.toggle('single', !double);
      stage.classList.toggle('fit-width', this.fit === 'width');
      stage.classList.toggle('fit-height', this.fit === 'height');
      stage.classList.toggle('fit-original', this.fit === 'original');
    },

    applyBackground() {
      const stage = document.getElementById('manga-stage');
      if (!stage) return;
      const map = { black: '#000000', white: '#ffffff', gray: '#333333' };
      stage.style.background = map[this.bg] || 'var(--manga-bg)';
    },

    applyTransform() {
      const spread = document.getElementById('manga-spread');
      if (!spread) return;
      spread.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    },

    showImageError(slot, i) {
      slot.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'manga-image-error';
      box.innerHTML =
        '<div class="manga-error-icon">🖼️</div>' +
        '<div>图片加载失败</div>' +
        '<button class="btn btn-small">重试</button>';
      const btn = box.querySelector('button');
      if (btn) {
        btn.addEventListener('click', async () => {
          const v = this.urlCache.get(i);
          if (v) {
            if (v.objectUrl) { try { URL.revokeObjectURL(v.objectUrl); } catch (e) {} }
            this.urlCache.delete(i);
          }
          await this.render();
        });
      }
      slot.appendChild(box);
    },

    // ---------- 翻页 ----------
    next() {
      if (!this.pages.length) return;
      const total = this.pages.length;
      const double = this.doubleMode && this.canDouble();
      if (double) {
        this.index = this.index <= 0 ? 1 : Math.min(this.index + 2, total - 1);
      } else {
        this.index = Math.min(this.index + 1, total - 1);
      }
      this.render();
    },

    prev() {
      if (!this.pages.length) return;
      const double = this.doubleMode && this.canDouble();
      if (double) this.index = this.index <= 1 ? 0 : this.index - 2;
      else this.index = Math.max(0, this.index - 1);
      this.render();
    },

    goToPage(i) {
      if (!this.pages.length) return;
      const total = this.pages.length;
      let idx = Math.max(0, Math.min(total - 1, Math.floor(Number(i) || 0)));
      const double = this.doubleMode && this.canDouble();
      if (double && idx > 0 && idx % 2 === 0) idx -= 1;
      this.index = idx;
      this.render();
    },

    nextChapter() { this.next(); },
    prevChapter() { this.prev(); },

    // ---------- 状态 ----------
    updateStatus() {
      const total = this.pages.length;
      const pct = total ? Math.round(((this.index + 1) / total) * 100) : 0;
      const indicator = document.getElementById('manga-page-indicator');
      if (indicator) indicator.textContent = `${total ? this.index + 1 : 0} / ${total}`;
      const p = document.getElementById('manga-status-percent');
      if (p) p.textContent = pct + '%';
      const loc = document.getElementById('manga-status-location');
      if (loc) loc.textContent = `第 ${total ? this.index + 1 : 0} / ${total} 页`;
      const mode = document.getElementById('manga-status-mode');
      if (mode) {
        mode.textContent = `${this.doubleMode && this.canDouble() ? '双页' : '单页'} · ${this.direction === 'rtl' ? '右到左' : '左到右'} · ${this.fitLabel()}`;
      }
      this.highlightToc();
    },

    fitLabel() {
      return this.fit === 'height' ? '适合高度' : this.fit === 'original' ? '原始大小' : '适合宽度';
    },

    // ---------- 目录（按子目录/卷分组，或逐页列出） ----------
    buildToc() {
      const list = document.getElementById('manga-toc-list');
      if (!list) return;
      const pages = this.pages;
      if (!pages.length) {
        list.innerHTML = '<div class="panel-empty muted">无内容</div>';
        return;
      }
      const groups = new Map();
      for (let i = 0; i < pages.length; i++) {
        const name = String(pages[i].name || '').replace(/\\/g, '/');
        const d = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push(i);
      }
      list.innerHTML = '';
      if (groups.size > 1) {
        // 多个子目录 → 视为多卷/多章
        for (const [dir, idxs] of groups) {
          const div = document.createElement('div');
          div.className = 'toc-item';
          div.innerHTML = `<span class="toc-label">${Library.escapeHtml(dir || '根目录')} · 第 ${idxs[0] + 1}-${idxs[idxs.length - 1] + 1} 页</span>`;
          div.addEventListener('click', () => { this.goToPage(idxs[0]); this.closeSidebar(); });
          list.appendChild(div);
        }
      } else {
        const cap = Math.min(pages.length, 1000);
        for (let i = 0; i < cap; i++) {
          const div = document.createElement('div');
          div.className = 'toc-item';
          div.dataset.page = String(i);
          const base = String(pages[i].name || '').split('/').pop();
          div.innerHTML = `<span class="toc-label">第 ${i + 1} 页 · ${Library.escapeHtml(base)}</span>`;
          div.addEventListener('click', () => { this.goToPage(i); this.closeSidebar(); });
          list.appendChild(div);
        }
        if (pages.length > cap) {
          const note = document.createElement('div');
          note.className = 'panel-empty muted';
          note.textContent = `仅列出前 ${cap} 页（共 ${pages.length} 页）`;
          list.appendChild(note);
        }
      }
      this.highlightToc();
    },

    highlightToc() {
      document.querySelectorAll('#manga-toc-list .toc-item[data-page]').forEach((el) => {
        el.classList.toggle('active', el.dataset.page === String(this.index));
      });
    },

    // ---------- 书签 ----------
    renderBookmarks() {
      const list = document.getElementById('manga-bookmark-list');
      if (!list) return;
      if (!this.bookmarks.length) {
        list.innerHTML = '<div class="panel-empty muted">暂无书签</div>';
        return;
      }
      list.innerHTML = '';
      for (let i = 0; i < this.bookmarks.length; i++) {
        const bm = this.bookmarks[i];
        const div = document.createElement('div');
        div.className = 'bookmark-item';
        div.innerHTML =
          '<div class="bookmark-main">' +
            `<div class="bookmark-chapter">${Library.escapeHtml(bm.label || ('第 ' + ((bm.pageIndex || 0) + 1) + ' 页'))}</div>` +
            `<div class="bookmark-meta muted">${bm.time ? new Date(bm.time).toLocaleString('zh-CN') : ''}</div>` +
            (bm.text ? `<div class="bookmark-snippet muted">${Library.escapeHtml(bm.text)}</div>` : '') +
          '</div>' +
          `<button class="btn btn-icon bookmark-del" data-index="${i}" title="删除">✕</button>`;
        div.querySelector('.bookmark-main').addEventListener('click', () => {
          this.goToPage(bm.pageIndex || 0);
          this.closeSidebar();
        });
        div.querySelector('.bookmark-del').addEventListener('click', () => {
          this.bookmarks.splice(i, 1);
          this.persistBookData();
          this.renderBookmarks();
        });
        list.appendChild(div);
      }
    },

    async addBookmark() {
      if (!this.loaded) return;
      const pageIndex = this.index;
      if (this.bookmarks.some((b) => b.pageIndex === pageIndex)) {
        App.toast('当前页已有书签');
        return;
      }
      const p = this.pages[pageIndex];
      this.bookmarks.push({
        pageIndex,
        label: `第 ${pageIndex + 1} 页`,
        text: p ? p.name : '',
        time: Date.now()
      });
      await this.persistBookData();
      this.renderBookmarks();
      App.toast('已添加书签');
    },

    // ---------- 进度持久化 ----------
    schedulePersist() {
      clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(() => this.persistBookData(), 800);
    },

    async persistBookData() {
      const path = App.state.currentBookPath || this.path;
      if (!path || !this.loaded) return;
      const total = this.pages.length;
      const percent = total ? Math.max(0, Math.min(100, ((this.index + 1) / total) * 100)) : 0;
      const data = {
        type: 'manga',
        pageIndex: this.index,
        total,
        percent,
        updatedAt: Date.now(),
        bookmarks: this.bookmarks
      };
      try {
        await window.api.setBookData(path, data);
        App.updateBookData(path, data);
      } catch (e) {}
    },

    async resetBookData() {
      const path = App.state.currentBookPath || this.path;
      if (!path) return;
      this.bookmarks = [];
      this.index = 0;
      await this.persistBookData();
      this.renderBookmarks();
      await this.render();
      App.toast('已重置本书阅读数据');
    },

    // ---------- 设置 ----------
    toggleDirection() {
      this.direction = this.direction === 'rtl' ? 'ltr' : 'rtl';
      App.state.settings.mangaDirection = this.direction;
      App.saveSettings();
      this.updateDirectionButton();
      this.render();
    },

    updateDirectionButton() {
      const b = document.getElementById('manga-btn-direction');
      if (b) b.textContent = this.direction === 'rtl' ? '右到左' : '左到右';
    },

    setFit(fit) {
      this.fit = fit === 'height' || fit === 'original' ? fit : 'width';
      App.state.settings.mangaFit = this.fit;
      App.saveSettings();
      this.applyStageClasses();
      this.render();
    },

    buildSettingsForm() {
      const form = document.getElementById('manga-settings-form');
      if (!form) return;
      const s = App.state.settings || {};
      const dirs = [
        { key: 'rtl', label: '右到左（日漫）' },
        { key: 'ltr', label: '左到右（韩漫/国漫）' }
      ];
      const bgs = [
        { key: 'auto', label: '跟随主题' },
        { key: 'black', label: '黑色' },
        { key: 'white', label: '白色' },
        { key: 'gray', label: '深灰' }
      ];
      const fits = [
        { key: 'width', label: '适合宽度' },
        { key: 'height', label: '适合高度' },
        { key: 'original', label: '原始大小' }
      ];
      form.innerHTML =
        '<div class="setting-group">' +
          '<div class="setting-label">默认阅读方向</div>' +
          '<div class="theme-options">' +
            dirs.map((d) => `<label class="theme-option ${this.direction === d.key ? 'active' : ''}"><input type="radio" name="m-dir" value="${d.key}" ${this.direction === d.key ? 'checked' : ''} /><span>${d.label}</span></label>`).join('') +
          '</div>' +
        '</div>' +
        `<div class="setting-group"><div class="setting-label">显示方式</div>` +
          `<select id="m-fit">${fits.map((f) => `<option value="${f.key}" ${this.fit === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}</select></div>` +
        `<div class="setting-group"><div class="setting-label">背景色</div>` +
          `<select id="m-bg">${bgs.map((b) => `<option value="${b.key}" ${this.bg === b.key ? 'selected' : ''}>${b.label}</option>`).join('')}</select></div>` +
        `<div class="setting-group row"><label class="switch-label"><input type="checkbox" id="m-double" ${this.doubleMode ? 'checked' : ''} /> 双页显示（宽屏时并排）</label></div>` +
        `<div class="setting-group row"><label class="switch-label"><input type="checkbox" id="m-preload" ${this.preload ? 'checked' : ''} /> 预加载前后页</label></div>` +
        '<div class="setting-actions"><button id="m-btn-reset" class="btn btn-danger">重置本书阅读数据</button></div>';

      form.querySelectorAll('input[name="m-dir"]').forEach((inp) => {
        inp.addEventListener('change', () => {
          this.direction = inp.value === 'ltr' ? 'ltr' : 'rtl';
          App.state.settings.mangaDirection = this.direction;
          App.saveSettings();
          this.updateDirectionButton();
          this.render();
          form.querySelectorAll('.theme-option').forEach((o) => o.classList.remove('active'));
          inp.closest('.theme-option').classList.add('active');
        });
      });

      const fitSel = document.getElementById('m-fit');
      if (fitSel) fitSel.addEventListener('change', () => this.setFit(fitSel.value));

      const bgSel = document.getElementById('m-bg');
      if (bgSel) bgSel.addEventListener('change', () => {
        this.bg = bgSel.value;
        App.state.settings.mangaBg = this.bg;
        App.saveSettings();
        this.applyBackground();
      });

      const dbl = document.getElementById('m-double');
      if (dbl) dbl.addEventListener('change', () => {
        this.doubleMode = dbl.checked;
        App.state.settings.mangaDouble = this.doubleMode;
        App.saveSettings();
        this.render();
      });

      const pre = document.getElementById('m-preload');
      if (pre) pre.addEventListener('change', () => {
        this.preload = pre.checked;
        App.state.settings.mangaPreload = this.preload;
        App.saveSettings();
        if (this.preload) { this.preloadAround(); }
      });

      const reset = document.getElementById('m-btn-reset');
      if (reset) reset.addEventListener('click', () => this.resetBookData());
    },

    // ---------- 交互 ----------
    onAreaClick(e) {
      if (this._suppressClick) { this._suppressClick = false; return; }
      if (this.zoom > 1) return;
      if (e.target.closest && e.target.closest('button')) return;
      const stage = document.getElementById('manga-stage');
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const leftZone = x < rect.width * 0.25;
      const rightZone = x > rect.width * 0.75;
      if (!leftZone && !rightZone) return;
      const nextOnLeft = this.direction === 'rtl';
      if (leftZone) { if (nextOnLeft) this.next(); else this.prev(); }
      else { if (nextOnLeft) this.prev(); else this.next(); }
    },

    onDblClick(e) {
      if (e.target.closest && e.target.closest('button')) return;
      this.zoom = this.zoom > 1 ? 1 : 2;
      if (this.zoom === 1) { this.panX = 0; this.panY = 0; }
      this.applyTransform();
      const stage = document.getElementById('manga-stage');
      if (stage) stage.classList.toggle('zoomed', this.zoom > 1);
    },

    onWheel(e) {
      if (this.zoom > 1) return; // 放大时交给拖拽
      const dy = e.deltaY || 0;
      const dx = e.deltaX || 0;
      if (Math.abs(dy) <= Math.abs(dx)) return;
      // 页面本身可滚动时先让原生滚动，到边缘再翻页
      const stage = document.getElementById('manga-stage');
      if (stage && stage.scrollHeight > stage.clientHeight + 4) {
        const atTop = stage.scrollTop <= 0;
        const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 4;
        if ((dy > 0 && !atBottom) || (dy < 0 && !atTop)) return;
      }
      e.preventDefault();
      if (Math.abs(dy) < 6) return;
      const now = Date.now();
      if (now - this._lastWheel < 320) return;
      this._lastWheel = now;
      if (dy > 0) this.next(); else this.prev();
    },

    onDragStart(e) {
      if (this.zoom <= 1 || e.button !== 0) return;
      this.dragging = true;
      this._dragMoved = false;
      this.dragStart = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
      const stage = document.getElementById('manga-stage');
      if (stage) stage.style.cursor = 'grabbing';
      e.preventDefault();
    },

    onDragMove(e) {
      if (!this.dragging || !this.dragStart) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this._dragMoved = true;
      this.panX = this.dragStart.panX + dx;
      this.panY = this.dragStart.panY + dy;
      this.applyTransform();
    },

    onDragEnd() {
      if (!this.dragging) return;
      this.dragging = false;
      if (this._dragMoved) this._suppressClick = true;
      const stage = document.getElementById('manga-stage');
      if (stage) stage.style.cursor = this.zoom > 1 ? 'grab' : '';
    },

    handleKeydown(e) {
      if (e.key === 'Escape') {
        if (this.sidebarPanel) this.closeSidebar();
        else App.goBack();
        return;
      }
      const tag = ((e.target && e.target.tagName) || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;

      const rtl = this.direction === 'rtl';
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (rtl) this.prev(); else this.next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (rtl) this.next(); else this.prev();
      } else if (e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        this.next();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        this.prev();
      }
    },

    // ---------- 侧边栏 ----------
    toggleSidebar(panel) {
      const sidebar = document.getElementById('manga-sidebar');
      if (!sidebar) return;
      if (this.sidebarPanel === panel && !sidebar.classList.contains('hidden')) {
        this.closeSidebar();
        return;
      }
      this.openSidebar(panel);
    },

    openSidebar(panel) {
      const sidebar = document.getElementById('manga-sidebar');
      if (!sidebar) return;
      sidebar.classList.remove('hidden');
      ['toc', 'bookmarks', 'settings'].forEach((n) => {
        const el = document.getElementById('manga-panel-' + n);
        if (el) el.classList.toggle('hidden', n !== panel);
      });
      this.sidebarPanel = panel;
      if (panel === 'settings') this.buildSettingsForm();
      if (panel === 'toc') this.highlightToc();
    },

    closeSidebar() {
      const sidebar = document.getElementById('manga-sidebar');
      if (sidebar) sidebar.classList.add('hidden');
      this.sidebarPanel = null;
    },

    // ---------- UI 辅助 ----------
    setTitle(title, sub) {
      const t = document.getElementById('manga-title-text');
      const a = document.getElementById('manga-author-text');
      if (t) t.textContent = title || '—';
      if (a) a.textContent = sub || '';
    },
    showLoading(on) {
      const el = document.getElementById('manga-loading');
      if (el) el.classList.toggle('hidden', !on);
    },
    hideError() {
      const el = document.getElementById('manga-error');
      if (!el) return;
      el.classList.add('hidden');
      el.innerHTML = '';
    },
    showError(msg) {
      const el = document.getElementById('manga-error');
      if (!el) return;
      el.classList.remove('hidden');
      el.innerHTML =
        '<div class="error-box">' +
          '<div class="error-title">无法打开这本漫画</div>' +
          `<div class="error-detail">${Library.escapeHtml(msg)}</div>` +
          '<button id="manga-error-back" class="btn">返回书库</button>' +
        '</div>';
      const btn = document.getElementById('manga-error-back');
      if (btn) btn.addEventListener('click', () => App.goBack());
    }
  };

  window.MangaReader = MangaReader;
  MangaReader.init();
})();
