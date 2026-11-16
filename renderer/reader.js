// reader.js
// 阅读器：epub.js 初始化、主题/排版注入、翻页、目录、书签、搜索、进度保存与恢复。

(function () {
  'use strict';

  // epub.js themes：每个主题定义正文前景/背景与链接色
  const THEME_STYLES = {
    light: {
      'body': { 'background': '#ffffff', 'color': '#242424' },
      'a': { 'color': '#3b6fe0' }
    },
    dark: {
      'body': { 'background': '#1e1e1e', 'color': '#d6d6d6' },
      'a': { 'color': '#8aa5ff' }
    },
    sepia: {
      'body': { 'background': '#f6f1e3', 'color': '#5b4a3a' },
      'a': { 'color': '#8a6d3b' }
    },
    night: {
      'body': { 'background': '#0a0c14', 'color': '#9aa3b5' },
      'a': { 'color': '#7d8fc7' }
    }
  };

  const FONT_FAMILIES = {
    system: '"Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif',
    serif: '"宋体", "SimSun", "Songti SC", serif',
    hei: '"黑体", "SimHei", "Microsoft YaHei", "PingFang SC", sans-serif',
    kai: '"楷体", "KaiTi", "STKaiti", "Kaiti SC", serif'
  };

  const Reader = {
    book: null,
    rendition: null,
    currentCfi: null,
    currentPercent: 0,
    currentHref: null,
    toc: [],
    bookmarks: [],
    loaded: false,
    sidebarPanel: null,
    lastQuery: '',
    _persistTimer: null,
    _resizeTimer: null,
    _lastWheel: 0,

    // ---------- 打开书籍 ----------
    async open(path, bookEntry) {
      this.reset();
      this.showLoading(true);
      this.hideError();
      this.setTitle(bookEntry.title || Library.baseName(path), bookEntry.author || '');

      try {
        // 1) 读取已保存的进度/书签
        const saved = await this.loadSavedData(path);
        this.bookmarks = (saved && Array.isArray(saved.bookmarks)) ? saved.bookmarks : [];
        const savedCfi = saved && saved.cfi ? saved.cfi : null;

        // 2) 通过受控 IPC 读取文件内容（绝不把 file:// 路径直接交给 epub.js）
        const res = await window.api.readEpub(path);
        if (!res || !res.ok) {
          const err = (res && res.error) || '未知错误';
          if (/白名单|拒绝读取/.test(err)) throw new Error('无法读取该文件（不在书库白名单）');
          throw new Error('文件不是有效的 EPUB 或包含 DRM');
        }
        // Uint8Array -> ArrayBuffer
        const u8 = new Uint8Array(res.data);
        const arrayBuffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

        // 3) 初始化 epub.js
        this.book = window.ePub(arrayBuffer);
        await this.book.ready;

        this.rendition = this.book.renderTo('viewer', {
          width: '100%',
          height: '100%',
          flow: App.state.settings.readingMode === 'scrolled' ? 'scrolled-doc' : 'paginated',
          spread: App.state.settings.doubleColumn ? 'always' : 'none',
          allowScriptedContent: false, // 禁止 EPUB 内脚本执行（安全）
          manager: 'default'
        });

        this.registerThemes();
        this.applyTypography();
        this.attachRenditionEvents();
        await this.rendition.display();

        // 4) 解析元数据补全标题/作者
        await this.resolveMetadata(path, bookEntry);

        // 5) 目录
        await this.buildToc();

        // 6) 恢复位置（失败回退到开头）
        let restored = false;
        if (savedCfi) {
          try {
            await this.rendition.display(savedCfi);
            restored = true;
          } catch (e) { restored = false; }
        }
        if (!restored) {
          if (savedCfi) App.toast('未能恢复上次位置，已回到开头');
          await this.rendition.display();
        }

        this.loaded = true;
        this.showLoading(false);
        this.renderBookmarks();
        this.updateModeUI();
      } catch (e) {
        this.showLoading(false);
        this.showError(this.friendlyError(e));
        this.cleanup();
      }
    },

    async resolveMetadata(path, bookEntry) {
      let title = bookEntry.title || '';
      let author = bookEntry.author || '';
      try {
        const md = await this.book.loaded.metadata;
        if (!title) title = String(md.title || '').trim();
        if (!author) author = String(md.creator || '').trim();
      } catch (e) { /* 忽略 */ }
      title = title || Library.baseName(path).replace(/\.epub$/i, '');
      author = author || '未知作者';
      this.setTitle(title, author);
      // 回填书库缓存
      const b = App.findBook(path);
      if (b && (!b.title || !b.author)) {
        b.title = title; b.author = author;
        App.scheduleSaveLibrary();
      }
    },

    friendlyError(e) {
      const msg = String((e && e.message) || e);
      if (/DRM|加密|encrypted/i.test(msg)) return '该文件可能包含 DRM 加密，无法阅读。';
      if (/拒绝读取|白名单/i.test(msg)) return '出于安全限制，无法读取该文件。';
      return '文件不是有效的 EPUB，或已损坏 / 包含 DRM。';
    },

    // ---------- 重置 / 清理 ----------
    reset() {
      this.cleanup();
      this.currentCfi = null;
      this.currentPercent = 0;
      this.currentHref = null;
      this.toc = [];
      this.bookmarks = [];
      this.loaded = false;
      this.sidebarPanel = null;
      this.lastQuery = '';
      document.getElementById('toc-list').innerHTML = '';
      document.getElementById('bookmark-list').innerHTML = '';
      document.getElementById('search-result-list').innerHTML = '';
      document.getElementById('status-percent').textContent = '0%';
      document.getElementById('status-chapter').textContent = '';
      document.getElementById('status-location').textContent = '';
      this.closeSidebar();
    },

    cleanup() {
      clearTimeout(this._persistTimer);
      clearTimeout(this._resizeTimer);
      if (this.rendition) { try { this.rendition.destroy(); } catch (e) {} this.rendition = null; }
      if (this.book) { try { this.book.destroy(); } catch (e) {} this.book = null; }
      document.getElementById('viewer').innerHTML = '';
    },

    async close() {
      if (this.loaded && App.state.currentBookPath) {
        await this.persistBookData();
      }
      this.cleanup();
      this.loaded = false;
    },

    // ---------- UI 辅助 ----------
    setTitle(title, author) {
      document.getElementById('reader-title-text').textContent = title || '—';
      document.getElementById('reader-author-text').textContent = author || '';
    },
    showLoading(on) {
      document.getElementById('reader-loading').classList.toggle('hidden', !on);
    },
    showError(msg) {
      const el = document.getElementById('reader-error');
      el.classList.remove('hidden');
      el.innerHTML =
        '<div class="error-box">' +
          '<div class="error-title">无法打开这本书</div>' +
          `<div class="error-detail">${Library.escapeHtml(msg)}</div>` +
          '<button id="btn-error-back" class="btn">返回书库</button>' +
        '</div>';
      const btn = document.getElementById('btn-error-back');
      if (btn) btn.addEventListener('click', () => App.goBack());
    },
    hideError() {
      const el = document.getElementById('reader-error');
      el.classList.add('hidden');
      el.innerHTML = '';
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

    // ---------- 主题/排版（通过 epub.js themes 注入，立即生效） ----------
    registerThemes() {
      for (const name in THEME_STYLES) {
        this.rendition.themes.register(name, THEME_STYLES[name]);
      }
    },

    applyTypography() {
      const s = App.state.settings;
      if (!this.rendition) return;
      // 主题配色（背景/文字/链接）与字号：走 epub.js 官方方法（字号变化会触发重排）
      try { this.rendition.themes.select(s.theme || 'light'); } catch (e) {}
      try { this.rendition.themes.fontSize((s.fontSize || 100) + '%'); } catch (e) {}
      // 字体族 / 行距 / 页边距 / 插图自适应：注入带 !important 的样式，
      // 确保能覆盖书籍自带的 CSS（epub.js themes.override 不带 !important，可能被书覆盖）
      const contents = this.getContentsSafe();
      if (contents) this.injectReaderStyle(contents);
      // 阅读区最大宽度（容器层面）
      const viewer = document.getElementById('viewer');
      viewer.style.maxWidth = (s.maxWidth || 840) + 'px';
      viewer.style.margin = '0 auto';
      // 排版变化后触发重排（防抖）
      this.scheduleResize();
    },

    // epub.js 0.3.93 的 rendition.getContents() 返回 Contents 数组（每个 view 一个），
    // 而旧代码按单个 Contents 使用，导致点击/滑动/搜索/样式注入全部失效。
    // 这里统一兼容「数组」与「单对象」两种返回。
    getContentsSafe() {
      try {
        const c = this.rendition ? this.rendition.getContents() : null;
        if (Array.isArray(c)) return c[0] || null;
        return c || null;
      } catch (e) {
        return null;
      }
    },

    // 注入阅读排版样式（每次内容渲染时通过 content hook 也会调用）
    injectReaderStyle(contents) {
      try {
        const doc = contents && contents.document;
        if (!doc || !doc.head) return;
        const s = App.state.settings;
        const css =
          'body {' +
            `font-family: ${FONT_FAMILIES[s.fontFamily] || FONT_FAMILIES.system} !important;` +
            `line-height: ${s.lineHeight || 1.8} !important;` +
            `padding: ${s.pageMargin || 24}px !important;` +
          '}' +
          'img, svg, video { max-width: 100% !important; height: auto !important; }' +
          'figure { text-align: center; margin: 1em auto; }';
        let style = doc.getElementById('__lnr_reader_style');
        if (!style) {
          style = doc.createElement('style');
          style.id = '__lnr_reader_style';
          doc.head.appendChild(style);
        }
        style.textContent = css;
      } catch (e) { /* 忽略 */ }
    },

    scheduleResize() {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        if (this.rendition) { try { this.rendition.resize(); } catch (e) {} }
      }, 200);
    },

    // 模式/双栏变化需要重建渲染
    async rebuildRendition() {
      if (!App.state.currentBookPath) return;
      const cfi = this.getCurrentCfi();
      this.cleanup();
      const res = await window.api.readEpub(App.state.currentBookPath);
      if (!res || !res.ok) { App.toast('重新渲染失败'); return; }
      const u8 = new Uint8Array(res.data);
      const arrayBuffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      this.book = window.ePub(arrayBuffer);
      await this.book.ready;
      this.rendition = this.book.renderTo('viewer', {
        width: '100%', height: '100%',
        flow: App.state.settings.readingMode === 'scrolled' ? 'scrolled-doc' : 'paginated',
        spread: App.state.settings.doubleColumn ? 'always' : 'none',
        allowScriptedContent: false,
        manager: 'default'
      });
      this.registerThemes();
      this.applyTypography();
      this.attachRenditionEvents();
      let restored = false;
      if (cfi) {
        try { await this.rendition.display(cfi); restored = true; } catch (e) {}
      }
      if (!restored) await this.rendition.display();
      this.updateModeUI();
      this.schedulePersist();
    },

    // ---------- 事件 ----------
    attachRenditionEvents() {
      this.rendition.on('relocated', (location) => this.onRelocated(location));
      this.rendition.on('rendered', () => this.onRendered());
      this.rendition.on('displayed', () => this.showLoading(false));
      // 每次内容渲染后注入排版样式（字体/行距/页边距/插图自适应）
      try {
        this.rendition.hooks.content.register((contents) => this.injectReaderStyle(contents));
      } catch (e) {}
    },

    onRelocated(location) {
      if (!location || !location.start) return;
      const start = location.start;
      this.currentCfi = start.cfi;
      this.currentHref = start.href;
      let pct = 0;
      if (typeof start.percentage === 'number' && isFinite(start.percentage) && start.percentage > 0) {
        pct = Math.round(start.percentage * 100);
      } else {
        // epub.js 未生成 locations 时 start.percentage 常为 0；
        // 用「spine 索引 + 当前章节内滚动/翻页比例」估算，保证滚动/翻页时百分比会变化。
        // 精确位置仍以 CFI 保存与恢复。
        let totalSections = 1;
        try {
          if (this.book && this.book.spine && this.book.spine.spineItems) totalSections = this.book.spine.spineItems.length;
          else if (this.book && this.book.spine && this.book.spine.length) totalSections = this.book.spine.length;
        } catch (e) {}
        const idx = Number.isFinite(start.index) ? start.index : 0;
        let frac = 0;
        if (App.state.settings.readingMode === 'scrolled') {
          try {
            const c = this.rendition && this.rendition.manager && this.rendition.manager.container;
            if (c && c.scrollHeight > c.clientHeight) {
              frac = Math.max(0, Math.min(1, c.scrollTop / Math.max(1, c.scrollHeight - c.clientHeight)));
            }
          } catch (e) {}
        } else if (start.displayed && start.displayed.total > 1) {
          frac = Math.max(0, Math.min(1, (start.displayed.page - 1) / start.displayed.total));
        }
        pct = Math.round(((idx + frac) / Math.max(1, totalSections)) * 100);
      }
      pct = Math.max(0, Math.min(100, pct));
      this.currentPercent = pct;
      document.getElementById('status-percent').textContent = pct + '%';
      const chapter = this.findChapter(start.href);
      document.getElementById('status-chapter').textContent = chapter ? chapter.label : '';
      this.highlightToc(start.href);
      this.schedulePersist();
    },

    onRendered() {
      // 在 iframe 内部文档上绑定点击翻页与左右滑动
      try {
        const contents = this.getContentsSafe();
        if (contents && contents.window) {
          const w = contents.window;
          if (!w.__lnrBound) {
            w.__lnrBound = true;
            w.addEventListener('click', (e) => this.onBookClick(e, w));
            // 鼠标滚轮翻页（分页模式下拦截，滚动模式放行原生滚动）
            w.addEventListener('wheel', (e) => this.onBookWheel(e), { passive: false });
            let sx = null, sy = null;
            w.addEventListener('touchstart', (e) => {
              if (e.touches && e.touches[0]) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
            }, { passive: true });
            w.addEventListener('touchend', (e) => {
              if (sx == null || !e.changedTouches || !e.changedTouches[0]) return;
              if (App.state.settings.readingMode !== 'paginated') { sx = sy = null; return; }
              const dx = e.changedTouches[0].clientX - sx;
              const dy = e.changedTouches[0].clientY - sy;
              if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
                if (dx < 0) this.next(); else this.prev();
              }
              sx = sy = null;
            });
          }
        }
      } catch (e) {}
    },

    onBookClick(e, w) {
      // 滚动模式下不拦截点击（交给原生滚动）
      if (App.state.settings.readingMode !== 'paginated') return;
      // 忽略链接点击与文本选区，避免误翻页
      if (e.target && e.target.closest && e.target.closest('a')) return;
      const sel = w.getSelection && w.getSelection();
      if (sel && sel.toString().trim()) return;
      // 注意：分页时 iframe 宽度可能远大于可视宽度（多栏横向排列），
      // 不能用 w.innerWidth 判断左右区域，要用管理器容器的可视宽度与 scrollLeft。
      let visibleW = w.innerWidth || 1;
      let scrollLeft = 0;
      try {
        const m = this.rendition.manager;
        if (m && m.container) {
          visibleW = m.container.clientWidth || visibleW;
          scrollLeft = m.container.scrollLeft || 0;
        }
      } catch (err) { /* 忽略 */ }
      const x = e.clientX - scrollLeft;
      if (x < visibleW * 0.25) this.prev();
      else if (x > visibleW * 0.75) this.next();
    },

    // 鼠标滚轮翻页：分页模式下向下滚 = 下一页，向上滚 = 上一页；
    // 滚动模式下直接放行，交给原生滚动。
    onBookWheel(e) {
      if (App.state.settings.readingMode !== 'paginated') return;
      if (!this.rendition) return;
      const dy = e.deltaY || 0;
      const dx = e.deltaX || 0;
      if (Math.abs(dy) <= Math.abs(dx)) return; // 忽略横向滚动
      e.preventDefault();
      if (Math.abs(dy) < 6) return; // 触控板微小滚动忽略
      const now = Date.now();
      if (now - this._lastWheel < 320) return; // 节流，避免一次滚动翻多页
      this._lastWheel = now;
      if (dy > 0) this.next();
      else this.prev();
    },

    // ---------- 翻页 / 章节 ----------
    next() { if (this.rendition) this.rendition.next(); },
    prev() { if (this.rendition) this.rendition.prev(); },

    nextChapter() {
      try {
        const loc = this.rendition.currentLocation();
        const start = loc && loc.start;
        if (!start) { this.rendition.next(); return; }
        const section = this.book.spine.get((start.href || '').split('#')[0]);
        const target = section && section.next;
        if (target) this.rendition.display(target).catch(() => {});
        else this.rendition.next();
      } catch (e) { if (this.rendition) this.rendition.next(); }
    },

    prevChapter() {
      try {
        const loc = this.rendition.currentLocation();
        const start = loc && loc.start;
        if (!start) { this.rendition.prev(); return; }
        const section = this.book.spine.get((start.href || '').split('#')[0]);
        const target = section && section.prev;
        if (target) this.rendition.display(target).catch(() => {});
        else this.rendition.prev();
      } catch (e) { if (this.rendition) this.rendition.prev(); }
    },

    // ---------- 分页 / 滚动模式 ----------
    getCurrentCfi() {
      try {
        const loc = this.rendition && this.rendition.currentLocation();
        if (loc && loc.start && loc.start.cfi) return loc.start.cfi;
      } catch (e) {}
      return this.currentCfi;
    },

    toggleReadingMode() {
      this.setReadingMode(App.state.settings.readingMode === 'scrolled' ? 'paginated' : 'scrolled');
    },

    // 切换 EPUB 排版：优先使用 epub.js rendition.flow，失败时重建 rendition。
    // 切换前记录 CFI，切换后 display(cfi) 恢复位置，避免丢失当前位置。
    async setReadingMode(mode) {
      const next = mode === 'scrolled' ? 'scrolled' : 'paginated';
      if (!this.rendition) {
        App.state.settings.readingMode = next;
        await App.saveSettings();
        this.updateModeUI();
        return;
      }
      if (App.state.settings.readingMode === next) { this.updateModeUI(); return; }

      const cfi = this.getCurrentCfi();
      this.currentCfi = cfi || this.currentCfi;
      App.state.settings.readingMode = next;
      await App.saveSettings();
      this.updateModeUI();

      let switched = false;
      try {
        if (typeof this.rendition.flow === 'function') {
          this.rendition.flow(next === 'scrolled' ? 'scrolled-doc' : 'paginated');
          // flow 之后 manager.isPaginated 必须同步变化，否则说明该 manager 不支持热切换
          const manager = this.rendition.manager;
          const wantPaginated = next !== 'scrolled';
          if (manager && typeof manager.isPaginated === 'boolean' && manager.isPaginated === wantPaginated) {
            if (cfi) await this.rendition.display(cfi);
            else await this.rendition.display();
            switched = true;
          }
        }
      } catch (e) { switched = false; }
      if (!switched) await this.rebuildRendition();
      this.schedulePersist();
      App.toast(next === 'scrolled' ? '已切换为滚动模式' : '已切换为翻页模式');
    },

    updateModeUI() {
      const scrolled = App.state.settings.readingMode === 'scrolled';
      const btn = document.getElementById('btn-reading-mode');
      if (btn) {
        btn.textContent = scrolled ? '📜 滚动' : '📖 翻页';
        btn.title = scrolled ? '当前：滚动模式，点击切换为翻页' : '当前：翻页模式，点击切换为滚动';
        btn.classList.toggle('active', scrolled);
      }
      // 滚动模式下禁用工具栏的上一页/下一页箭头；章节仍可通过目录或 Alt+←/→ 跳转
      const prev = document.getElementById('btn-prev-chapter');
      const next = document.getElementById('btn-next-chapter');
      if (prev) {
        prev.disabled = scrolled;
        prev.title = scrolled ? '滚动模式下不可用（使用滚轮 / ↑↓）' : '上一章 (Alt+←)';
      }
      if (next) {
        next.disabled = scrolled;
        next.title = scrolled ? '滚动模式下不可用（使用滚轮 / ↑↓）' : '下一章 (Alt+→)';
      }
      const sel = document.getElementById('set-mode');
      if (sel) sel.value = scrolled ? 'scrolled' : 'paginated';
      const main = document.getElementById('reader-main');
      if (main) main.classList.toggle('reading-scrolled', scrolled);
    },

    // 滚动模式下的键盘滚动：scrolled-doc / continuous 真正滚动的是 manager.container
    scrollByPage(dir) {
      try {
        const contents = this.getContentsSafe();
        const win = contents && contents.window;
        const doc = contents && contents.document;
        const manager = this.rendition && this.rendition.manager;
        const container = manager && manager.container;
        const h = (container && container.clientHeight) || (win && win.innerHeight) || 600;
        const delta = Math.floor(h * 0.9) * (dir < 0 ? -1 : 1);
        // 优先滚 manager.container：scrolled-doc 的 iframe 高度等于全文高度，滚它没有效果
        if (container && container.scrollHeight > container.clientHeight + 20) {
          container.scrollBy({ top: delta, behavior: 'smooth' });
          return;
        }
        if (win && doc && doc.body && doc.body.scrollHeight > win.innerHeight + 20) {
          win.scrollBy({ top: delta, behavior: 'smooth' });
          return;
        }
        const viewer = document.getElementById('viewer');
        if (viewer) viewer.scrollBy({ top: delta, behavior: 'smooth' });
      } catch (e) {}
    },

    // ---------- 目录 ----------
    async buildToc() {
      this.toc = [];
      try {
        const nav = this.book.navigation;
        const raw = (nav && nav.toc) ? nav.toc : [];
        const flatten = (items, depth) => {
          for (const it of items) {
            if (!it) continue;
            this.toc.push({ href: it.href, label: it.label || '未命名章节', depth: depth || 0 });
            if (it.subitems && it.subitems.length) flatten(it.subitems, (depth || 0) + 1);
          }
        };
        flatten(raw, 0);
      } catch (e) {}
      this.renderToc();
    },

    renderToc() {
      const list = document.getElementById('toc-list');
      if (!this.toc.length) {
        list.innerHTML = '<div class="panel-empty muted">本书无目录</div>';
        return;
      }
      list.innerHTML = '';
      for (const item of this.toc) {
        const div = document.createElement('div');
        div.className = 'toc-item' + (item.depth ? ' indented' : '');
        div.dataset.href = item.href;
        div.innerHTML = `<span class="toc-label">${Library.escapeHtml(item.label)}</span>`;
        div.addEventListener('click', () => {
          this.rendition.display(item.href).catch(() => {});
        });
        list.appendChild(div);
      }
    },

    findChapter(href) {
      if (!href) return null;
      let best = null;
      for (const it of this.toc) {
        if (it.href === href) return it;
        const h = href.split('#')[0];
        const ih = (it.href || '').split('#')[0];
        if (h && ih && (h === ih || h.startsWith(ih) || ih.startsWith(h))) best = it;
      }
      return best;
    },

    highlightToc(href) {
      document.querySelectorAll('#toc-list .toc-item').forEach((el) => {
        const h = el.dataset.href;
        const hh = (href || '').split('#')[0];
        const ih = (h || '').split('#')[0];
        const active = h === href || (hh && ih && (hh === ih || hh.startsWith(ih) || ih.startsWith(hh)));
        el.classList.toggle('active', !!active);
        if (active) el.scrollIntoView({ block: 'nearest' });
      });
    },

    // ---------- 书签 ----------
    renderBookmarks() {
      const list = document.getElementById('bookmark-list');
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
            `<div class="bookmark-chapter">${Library.escapeHtml(bm.chapter || '未命名位置')}</div>` +
            `<div class="bookmark-meta muted">进度 ${Math.round(bm.percent || 0)}% · ${bm.time ? new Date(bm.time).toLocaleString('zh-CN') : ''}</div>` +
            (bm.text ? `<div class="bookmark-snippet muted">${Library.escapeHtml(bm.text)}</div>` : '') +
          '</div>' +
          `<button class="btn btn-icon bookmark-del" data-index="${i}" title="删除">✕</button>`;
        div.querySelector('.bookmark-main').addEventListener('click', () => {
          this.rendition.display(bm.cfi).catch(() => App.toast('跳转失败'));
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
      if (!this.rendition) return;
      const loc = this.rendition.currentLocation();
      if (!loc || !loc.start || !loc.start.cfi) { App.toast('无法在此位置添加书签'); return; }
      const chapter = this.findChapter(loc.start.href);
      let snippet = '';
      try {
        const contents = this.getContentsSafe();
        if (contents && contents.document && contents.document.body) {
          snippet = (contents.document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        }
      } catch (e) {}
      this.bookmarks.push({
        cfi: loc.start.cfi,
        href: loc.start.href,
        chapter: chapter ? chapter.label : '',
        percent: this.currentPercent,
        text: snippet,
        time: Date.now()
      });
      await this.persistBookData();
      this.renderBookmarks();
      App.toast('已添加书签');
    },

    // ---------- 搜索 ----------
    doSearch() {
      const input = document.getElementById('reader-search-input');
      const q = (input.value || '').trim();
      if (!q) { App.toast('请输入搜索关键词'); return; }
      this.lastQuery = q;
      const full = document.getElementById('search-scope-full').checked;
      if (full) this.searchFullBook(q);
      else this.searchCurrentChapter(q);
    },

    searchCurrentChapter(q) {
      try {
        const contents = this.getContentsSafe();
        if (!contents || !contents.document) { App.toast('搜索失败'); return; }
        const results = this.collectMatches(contents.document, q);
        this.searchCurrentResults = results;
        this.renderSearchResults(results, 'current');
        if (!results.length) App.toast('当前章节未找到匹配');
      } catch (e) { App.toast('搜索失败'); }
    },

    async searchFullBook(q) {
      App.toast('正在全书搜索…');
      const results = [];
      try {
        const items = (this.book.spine && this.book.spine.spineItems) ? this.book.spine.spineItems : [];
        for (const section of items) {
          try {
            await section.load(this.book.load.bind(this.book));
            const doc = section.document;
            if (!doc || !doc.body) continue;
            const text = doc.body.innerText || '';
            const lower = text.toLowerCase();
            let idx = lower.indexOf(q.toLowerCase());
            while (idx >= 0 && results.length < 500) {
              results.push({
                href: section.href,
                snippet: text.slice(Math.max(0, idx - 30), idx + q.length + 40).replace(/\s+/g, ' ').trim()
              });
              idx = lower.indexOf(q.toLowerCase(), idx + 1);
            }
          } catch (e) { /* 跳过无法读取的章节 */ }
        }
      } catch (e) {}
      this.renderSearchResults(results, 'full');
      if (!results.length) App.toast('全书未找到匹配');
    },

    collectMatches(doc, q) {
      const results = [];
      if (!doc || !doc.body) return results;
      const lowerQ = q.toLowerCase();
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue || '';
        const lower = text.toLowerCase();
        let idx = lower.indexOf(lowerQ);
        while (idx >= 0) {
          results.push({
            node: node,
            index: idx,
            snippet: text.slice(Math.max(0, idx - 30), idx + q.length + 40).replace(/\s+/g, ' ').trim()
          });
          idx = lower.indexOf(lowerQ, idx + 1);
        }
      }
      return results;
    },

    renderSearchResults(results, scope) {
      const list = document.getElementById('search-result-list');
      if (!results.length) {
        list.innerHTML = '<div class="panel-empty muted">无结果</div>';
        return;
      }
      list.innerHTML = '';
      const cap = Math.min(results.length, 200);
      for (let i = 0; i < cap; i++) {
        const r = results[i];
        const div = document.createElement('div');
        div.className = 'search-item';
        div.innerHTML = `<div class="search-snippet">${Library.escapeHtml(r.snippet || '…')}</div>`;
        div.addEventListener('click', async () => {
          if (scope === 'full' && r.href) {
            try { await this.rendition.display(r.href); } catch (e) {}
            setTimeout(() => {
              this.searchCurrentChapter(this.lastQuery);
              if (this.searchCurrentResults && this.searchCurrentResults.length) {
                this.jumpToMatch(this.searchCurrentResults[0]);
              }
            }, 300);
          } else {
            this.jumpToMatch(r);
          }
        });
        list.appendChild(div);
      }
      if (results.length > cap) {
        const more = document.createElement('div');
        more.className = 'panel-empty muted';
        more.textContent = `仅显示前 ${cap} 条结果`;
        list.appendChild(more);
      }
    },

    jumpToMatch(r) {
      try {
        const contents = this.getContentsSafe();
        if (!contents) return;
        const w = contents.window;
        const d = contents.document;
        const qLen = (this.lastQuery || '').length;
        const range = d.createRange();
        range.setStart(r.node, r.index);
        range.setEnd(r.node, r.index + qLen);
        const sel = w.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const rect = range.getBoundingClientRect();
        if (rect) w.scrollTo(0, rect.top + w.scrollY - 120);
      } catch (e) {}
    },

    // ---------- 设置面板 ----------
    buildSettingsForm() {
      const form = document.getElementById('reader-settings-form');
      const s = App.state.settings;
      const themes = [
        { key: 'light', label: '浅色' }, { key: 'dark', label: '深色' },
        { key: 'sepia', label: '护眼米色' }, { key: 'night', label: '夜间' }
      ];
      const fonts = [
        { key: 'system', label: '系统默认' }, { key: 'serif', label: '宋体' },
        { key: 'hei', label: '黑体' }, { key: 'kai', label: '楷体' }
      ];

      form.innerHTML =
        '<div class="setting-group">' +
          '<div class="setting-label">主题</div>' +
          '<div class="theme-options">' +
            themes.map((t) =>
              `<label class="theme-option ${s.theme === t.key ? 'active' : ''}">` +
                `<input type="radio" name="r-theme" value="${t.key}" ${s.theme === t.key ? 'checked' : ''} />` +
                `<span>${t.label}</span></label>`
            ).join('') +
          '</div>' +
        '</div>' +
        `<div class="setting-group"><div class="setting-label">字体大小 <span class="val" id="val-fontsize">${s.fontSize}%</span></div>` +
          `<input type="range" id="set-fontsize" min="80" max="200" step="5" value="${s.fontSize}" /></div>` +
        `<div class="setting-group"><div class="setting-label">行距 <span class="val" id="val-lineheight">${s.lineHeight}</span></div>` +
          `<input type="range" id="set-lineheight" min="1.2" max="2.6" step="0.1" value="${s.lineHeight}" /></div>` +
        `<div class="setting-group"><div class="setting-label">页边距 <span class="val" id="val-pagemargin">${s.pageMargin}px</span></div>` +
          `<input type="range" id="set-pagemargin" min="8" max="80" step="4" value="${s.pageMargin}" /></div>` +
        `<div class="setting-group"><div class="setting-label">字体</div>` +
          `<select id="set-fontfamily">${fonts.map((f) => `<option value="${f.key}" ${s.fontFamily === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}</select></div>` +
        `<div class="setting-group"><div class="setting-label">阅读模式</div>` +
          `<select id="set-mode">` +
            `<option value="paginated" ${s.readingMode === 'paginated' ? 'selected' : ''}>分页</option>` +
            `<option value="scrolled" ${s.readingMode === 'scrolled' ? 'selected' : ''}>滚动</option>` +
          `</select></div>` +
        `<div class="setting-group"><div class="setting-label">阅读区最大宽度 <span class="val" id="val-maxwidth">${s.maxWidth}px</span></div>` +
          `<input type="range" id="set-maxwidth" min="480" max="1600" step="40" value="${s.maxWidth}" /></div>` +
        `<div class="setting-group row"><label class="switch-label">` +
          `<input type="checkbox" id="set-double" ${s.doubleColumn ? 'checked' : ''} /> 宽屏双栏显示</label></div>` +
        '<div class="setting-actions"><button id="btn-reset-book" class="btn btn-danger">重置本书阅读数据</button></div>';

      const bindRange = (id, valId, fmt, apply) => {
        const el = document.getElementById(id);
        el.addEventListener('input', () => {
          const v = parseFloat(el.value);
          document.getElementById(valId).textContent = fmt(v);
          apply(v);
        });
        el.addEventListener('change', () => App.saveSettings());
      };

      form.querySelectorAll('input[name="r-theme"]').forEach((inp) => {
        inp.addEventListener('change', () => {
          App.state.settings.theme = inp.value;
          App.applyAppTheme();
          this.applyTypography();
          App.saveSettings();
          form.querySelectorAll('.theme-option').forEach((o) => o.classList.remove('active'));
          inp.closest('.theme-option').classList.add('active');
        });
      });

      bindRange('set-fontsize', 'val-fontsize', (v) => v + '%', (v) => { App.state.settings.fontSize = v; this.applyTypography(); });
      bindRange('set-lineheight', 'val-lineheight', (v) => v, (v) => { App.state.settings.lineHeight = v; this.applyTypography(); });
      bindRange('set-pagemargin', 'val-pagemargin', (v) => v + 'px', (v) => { App.state.settings.pageMargin = v; this.applyTypography(); });
      bindRange('set-maxwidth', 'val-maxwidth', (v) => v + 'px', (v) => { App.state.settings.maxWidth = v; this.applyTypography(); });

      document.getElementById('set-fontfamily').addEventListener('change', (e) => {
        App.state.settings.fontFamily = e.target.value;
        this.applyTypography();
        App.saveSettings();
      });

      document.getElementById('set-mode').addEventListener('change', async (e) => {
        await this.setReadingMode(e.target.value);
      });

      document.getElementById('set-double').addEventListener('change', async (e) => {
        App.state.settings.doubleColumn = e.target.checked;
        App.saveSettings();
        await this.rebuildRendition();
      });

      document.getElementById('btn-reset-book').addEventListener('click', () => this.resetBookData());
    },

    async resetBookData() {
      if (!App.state.currentBookPath) return;
      this.bookmarks = [];
      this.currentCfi = null;
      this.currentPercent = 0;
      await this.persistBookData();
      this.renderBookmarks();
      try { await this.rendition.display(); } catch (e) {}
      App.toast('已重置本书阅读数据');
    },

    // ---------- 进度/书签持久化 ----------
    schedulePersist() {
      clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(() => this.persistBookData(), 800);
    },

    async persistBookData() {
      const path = App.state.currentBookPath;
      if (!path) return;
      const book = App.findBook(path);
      const data = {
        cfi: this.currentCfi || null,
        percent: this.currentPercent || 0,
        updatedAt: Date.now(),
        bookmarks: this.bookmarks,
        size: book ? book.size : null,
        mtime: book ? book.mtime : null
      };
      try {
        await window.api.setBookData(path, data);
        App.updateBookData(path, data);
      } catch (e) {}
    },

    // ---------- 侧边栏 ----------
    toggleSidebar(panel) {
      const sidebar = document.getElementById('sidebar');
      if (this.sidebarPanel === panel && !sidebar.classList.contains('hidden')) {
        this.closeSidebar();
        return;
      }
      this.openSidebar(panel);
    },

    openSidebar(panel) {
      const sidebar = document.getElementById('sidebar');
      sidebar.classList.remove('hidden');
      ['toc', 'bookmarks', 'search', 'settings'].forEach((n) => {
        document.getElementById('panel-' + n).classList.toggle('hidden', n !== panel);
      });
      this.sidebarPanel = panel;
      if (panel === 'settings') this.buildSettingsForm();
      if (panel === 'toc') this.highlightToc(this.currentHref);
      if (panel === 'search') setTimeout(() => document.getElementById('reader-search-input').focus(), 50);
    },

    closeSidebar() {
      document.getElementById('sidebar').classList.add('hidden');
      this.sidebarPanel = null;
    },

    handleEscape() {
      if (this.sidebarPanel) this.closeSidebar();
      else App.goBack();
    },

    // ---------- 键盘 ----------
    handleKeydown(e) {
      if (e.key === 'Escape') {
        this.handleEscape();
        return;
      }
      const tag = ((e.target && e.target.tagName) || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); this.nextChapter(); return; }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); this.prevChapter(); return; }
      if (App.state.settings.readingMode === 'scrolled') {
        if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
          e.preventDefault(); this.scrollByPage(1);
        } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
          e.preventDefault(); this.scrollByPage(-1);
        }
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault(); this.next();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault(); this.prev();
      }
    }
  };

  window.Reader = Reader;

  // 鼠标滚轮翻页：iframe 内的滚轮由 onRendered 绑定，这里处理 viewer 边缘空白区域
  const viewerEl = document.getElementById('viewer');
  if (viewerEl) {
    viewerEl.addEventListener('wheel', (e) => Reader.onBookWheel(e), { passive: false });
  }
})();
