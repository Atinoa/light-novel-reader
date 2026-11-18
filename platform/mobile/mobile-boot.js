// platform/mobile/mobile-boot.js
// 只在 www 移动构建中加载；桌面 renderer 不会引用此文件。
(function () {
  'use strict';

  if (!window.MangaUtil || !window.MangaReader || !window.MobileManga) return;

  // 大 EPUB 不在书库卡片阶段后台解析（60MB+ 会与打开阅读器并发抢 CPU/内存）；
  // 打开阅读器后由 reader.js 的 resolveMetadata 回填标题/作者。
  if (window.Library && typeof window.Library.enqueueMetadata === 'function') {
    const originalEnqueue = window.Library.enqueueMetadata;
    window.Library.enqueueMetadata = function (books) {
      const small = [];
      for (const b of books || []) {
        if (b && b.type === 'epub' && b.size > 20 * 1024 * 1024) {
          b._parsed = true;
          b._queued = false;
          continue;
        }
        small.push(b);
      }
      return originalEnqueue.call(this, small);
    };
  }

  // epub.js 默认会为每个 resource 预生成 blob URL；60MB+ 的图文 EPUB 可能有几百个资源，
  // 手机会卡很久。大 EPUB 关闭 replacements，优先保证正文可读；小 EPUB 保持默认。
  if (window.ePub) {
    const originalEPub = window.ePub;
    window.ePub = function (input, options) {
      try {
        const size = input && (input.byteLength || input.length || 0);
        if (size > 20 * 1024 * 1024) {
          return originalEPub(input, { ...(options || {}), replacements: 'none' });
        }
      } catch (e) { /* ignore */ }
      return originalEPub(input, options);
    };
  }

  // 卡片封面：MobileManga 预生成 book.coverUrl 后，MangaUtil 优先返回它
  const originalBuildUrl = window.MangaUtil.buildUrl;
  window.MangaUtil.buildUrl = function (book, pageName) {
    if (book && book.coverUrl && pageName === book.coverPath) return book.coverUrl;
    return originalBuildUrl.call(this, book, pageName);
  };

  // 漫画页：不再走 manga://，改为读取 File/ZIP 后生成 Blob URL
  const originalEnsurePage = window.MangaReader.ensurePage;
  window.MangaReader.ensurePage = async function (i) {
    if (!window.MobileManga) return originalEnsurePage.call(this, i);
    if (i < 0 || i >= this.pages.length) return null;

    const cached = this.urlCache.get(i);
    if (cached) return cached;

    const name = this.pages[i].name;
    const entry = { index: i, name, url: null, objectUrl: null, error: false };
    this.urlCache.set(i, entry);

    try {
      const url = await window.MobileManga.resolvePageUrl(this.book, name);
      entry.url = url;
      entry.objectUrl = url;
    } catch (e) {
      entry.error = true;
    }
    return entry;
  };

  const originalClose = window.MangaReader.close;
  window.MangaReader.close = async function () {
    const bookPath = this.path;
    const book = this.book;
    try {
      if (bookPath) window.MobileManga.closeBook(bookPath, book && book.coverPath);
    } catch (e) { /* ignore */ }
    const result = await originalClose.apply(this, arguments);
    // 原 close 会 revoke 当前页 objectURL；封面若与第 1 页共用 URL，需要重新生成
    if (bookPath && book && book.coverPath) {
      try { await window.MobileManga.refreshCover(book); } catch (e) { /* ignore */ }
    }
    return result;
  };

  // 移动端书单：只展示“批次”书单，隐藏桌面文件夹（Android 上文件夹概念不可靠）
  if (window.Library && typeof window.Library.renderFolders === 'function') {
    const originalRenderFolders = window.Library.renderFolders;
    window.Library.renderFolders = function () {
      const result = originalRenderFolders.call(this);
      document.querySelectorAll('#folders-list .folder-source').forEach((li) => {
        li.dataset.batch = String(li.dataset.source || '').startsWith('batch://') ? '1' : '0';
      });
      return result;
    };
  }

  // 移动端左侧书单改为抽屉
  function installMobileHeader() {
    if (document.getElementById('mobile-drawer-btn')) return;
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;

    const drawerBtn = document.createElement('button');
    drawerBtn.id = 'mobile-drawer-btn';
    drawerBtn.className = 'btn btn-icon mobile-only';
    drawerBtn.title = '书单 / 分类';
    drawerBtn.textContent = '☰';
    topbar.insertBefore(drawerBtn, topbar.firstChild);

    // 把搜索框从桌面 actions 里移出来，移动端默认折叠
    const searchBox = document.querySelector('.topbar-actions .search-box');
    if (searchBox) topbar.appendChild(searchBox);

    const searchBtn = document.createElement('button');
    searchBtn.id = 'mobile-search-btn';
    searchBtn.className = 'btn btn-icon mobile-only';
    searchBtn.title = '搜索';
    searchBtn.textContent = '🔍';
    topbar.appendChild(searchBtn);

    const moreBtn = document.createElement('button');
    moreBtn.id = 'mobile-more-btn';
    moreBtn.className = 'btn btn-icon mobile-only';
    moreBtn.title = '更多操作';
    moreBtn.textContent = '⋯';
    topbar.appendChild(moreBtn);

    const importBtn = document.createElement('button');
    importBtn.id = 'mobile-import-btn';
    importBtn.className = 'btn btn-icon mobile-only';
    importBtn.title = '导入文件';
    importBtn.setAttribute('aria-label', '导入文件');
    importBtn.textContent = '＋';
    topbar.insertBefore(importBtn, searchBtn);

    const overlay = document.createElement('div');
    overlay.className = 'mobile-drawer-overlay';
    document.body.appendChild(overlay);

    const closeDrawer = () => document.body.classList.remove('mobile-drawer-open');
    drawerBtn.addEventListener('click', () => {
      document.body.classList.toggle('mobile-drawer-open');
    });
    overlay.addEventListener('click', closeDrawer);
    document.getElementById('folders-list')?.addEventListener('click', closeDrawer);
    document.getElementById('source-all')?.addEventListener('click', closeDrawer);
    document.getElementById('source-single')?.addEventListener('click', closeDrawer);

    const safeImport = async (task, label) => {
      try {
        await task();
      } catch (e) {
        console.error(label, e);
        if (window.App && typeof App.toast === 'function') {
          App.toast(`${label}：${(e && e.message) || e}`);
        }
      }
    };

    // 顶部“＋导入”Action Sheet
    const importOverlay = document.createElement('div');
    importOverlay.className = 'mobile-import-overlay';
    const importSheet = document.createElement('div');
    importSheet.className = 'mobile-import-sheet';
    importSheet.innerHTML = `
      <div class="mobile-sheet-handle"></div>
      <div class="mobile-sheet-title">导入</div>
      <button class="mobile-menu-item" data-import="files">
        <span>📚</span>
        <span class="mobile-menu-text"><b>选择文件（可多选）</b><small>EPUB / TXT / PKZ / CBZ</small></span>
      </button>
      <button class="mobile-menu-item" data-import="manga">
        <span>🖼️</span>
        <span class="mobile-menu-text"><b>选图片作为漫画</b><small>一次选择多张图片</small></span>
      </button>
      <button class="mobile-menu-item mobile-menu-cancel" data-import="cancel"><b>取消</b></button>
    `;
    document.body.appendChild(importOverlay);
    document.body.appendChild(importSheet);

    const closeImport = () => document.body.classList.remove('mobile-import-open');
    const openImport = () => {
      document.body.classList.remove('mobile-drawer-open', 'mobile-menu-open', 'mobile-search-open');
      document.body.classList.add('mobile-import-open');
    };
    importBtn.addEventListener('click', () => {
      if (document.body.classList.contains('mobile-import-open')) closeImport();
      else openImport();
    });
    importOverlay.addEventListener('click', closeImport);
    importSheet.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-import]');
      if (!btn) return;
      const kind = btn.dataset.import;
      closeImport();
      if (kind === 'cancel') return;
      importBtn.disabled = true;
      importBtn.classList.add('busy');
      try {
        if (kind === 'files') await safeImport(() => App.openFile(), '导入失败');
        else if (kind === 'manga') await safeImport(() => App.openMangaFolder(), '漫画导入失败');
      } finally {
        importBtn.disabled = false;
        importBtn.classList.remove('busy');
      }
    });

    // 更多操作底部面板
    const menuOverlay = document.createElement('div');
    menuOverlay.className = 'mobile-menu-overlay';
    const sheet = document.createElement('div');
    sheet.className = 'mobile-menu-sheet';
    sheet.innerHTML = `
      <div class="mobile-sheet-handle"></div>
      <div class="mobile-sheet-title">更多操作</div>
      <button class="mobile-menu-item" data-action="refresh"><span>🔄</span><b>刷新书库</b></button>
      <button class="mobile-menu-item" data-action="view"><span>▦</span><b>切换 网格 / 列表</b></button>
      <button class="mobile-menu-item" data-action="page"><span>📖</span><b>切换 分页 / 滚动</b></button>
      <button class="mobile-menu-item" data-action="settings"><span>⚙️</span><b>阅读设置</b></button>
    `;
    document.body.appendChild(menuOverlay);
    document.body.appendChild(sheet);

    const closeMenu = () => document.body.classList.remove('mobile-menu-open');
    const openMenu = () => {
      const viewBtn = sheet.querySelector('[data-action="view"] b');
      const pageBtn = sheet.querySelector('[data-action="page"] b');
      if (viewBtn) viewBtn.textContent = Library.viewMode === 'grid' ? '切换为列表视图' : '切换为网格视图';
      if (pageBtn) pageBtn.textContent = Library.pageMode === 'paginated' ? '切换为滚动模式' : '切换为分页模式';
      document.body.classList.remove('mobile-drawer-open', 'mobile-import-open', 'mobile-search-open');
      document.body.classList.add('mobile-menu-open');
    };
    moreBtn.addEventListener('click', openMenu);
    menuOverlay.addEventListener('click', closeMenu);

    sheet.addEventListener('click', async (e) => {
      const btn = e.target.closest('.mobile-menu-item');
      if (!btn) return;
      const action = btn.dataset.action;
      closeMenu();
      if (action === 'refresh') await App.refreshLibrary();
      else if (action === 'view') Library.toggleView();
      else if (action === 'page') Library.setPageMode(Library.pageMode === 'paginated' ? 'scroll' : 'paginated');
      else if (action === 'settings') Library.openGlobalSettings();
    });

    // 搜索展开/收起
    searchBtn.addEventListener('click', () => {
      const open = document.body.classList.toggle('mobile-search-open');
      if (open) setTimeout(() => document.getElementById('search-input')?.focus(), 80);
    });
    document.getElementById('search-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        document.body.classList.remove('mobile-search-open');
        e.currentTarget.blur();
      }
    });
  }

  // 阅读器沉浸式：默认隐藏上下控制栏，点击中间切换
  function installReaderControls() {
    const toggle = (viewId) => {
      const view = document.getElementById(viewId);
      if (!view) return;
      view.classList.toggle('mobile-controls-visible');
    };
    const inCenter = (x, width) => x > width * 0.3 && x < width * 0.7;
    const isControlTarget = (target) =>
      target && target.closest && target.closest('button, a, input, select, textarea, .sidebar');

    const originalBookClick = Reader.onBookClick;
    Reader.onBookClick = function (e, w) {
      if (isControlTarget(e.target)) return originalBookClick.call(this, e, w);
      let width = (w && w.innerWidth) || 1;
      let left = 0;
      try {
        const m = this.rendition && this.rendition.manager;
        if (m && m.container) {
          width = m.container.clientWidth || width;
          left = m.container.scrollLeft || 0;
        }
      } catch (err) { /* ignore */ }
      if (inCenter(e.clientX - left, width)) {
        toggle('reader-view');
        return;
      }
      return originalBookClick.call(this, e, w);
    };

    const originalTxtClick = TxtReader.onAreaClick;
    TxtReader.onAreaClick = function (e) {
      if (isControlTarget(e.target)) return originalTxtClick.call(this, e);
      const scroll = document.getElementById('txt-scroll');
      if (scroll) {
        const rect = scroll.getBoundingClientRect();
        if (inCenter(e.clientX - rect.left, rect.width)) {
          toggle('txt-view');
          return;
        }
      }
      return originalTxtClick.call(this, e);
    };

    const originalMangaClick = MangaReader.onAreaClick;
    MangaReader.onAreaClick = function (e) {
      if (this.zoom > 1) return originalMangaClick.call(this, e);
      if (isControlTarget(e.target)) return originalMangaClick.call(this, e);
      const stage = document.getElementById('manga-stage');
      if (stage) {
        const rect = stage.getBoundingClientRect();
        if (inCenter(e.clientX - rect.left, rect.width)) {
          toggle('manga-view');
          return;
        }
      }
      return originalMangaClick.call(this, e);
    };

    // 打开新书时先隐藏控制栏；首次提示一次
    const wrappers = [
      ['showReader', 'reader-view'],
      ['showTxtReader', 'txt-view'],
      ['showMangaReader', 'manga-view']
    ];
    for (const [fn, viewId] of wrappers) {
      if (typeof App[fn] !== 'function') continue;
      const original = App[fn];
      App[fn] = function (...args) {
        document.getElementById(viewId)?.classList.remove('mobile-controls-visible');
        const result = original.apply(this, args);
        if (!sessionStorage.getItem('lnr-mobile-controls-hint')) {
          sessionStorage.setItem('lnr-mobile-controls-hint', '1');
          setTimeout(() => App.toast('轻触屏幕中间可显示控制栏'), 500);
        }
        return result;
      };
    }
  }

  // 长按卡片 → 现有上下文菜单
  function installLongPress() {
    const container = document.getElementById('books-container');
    if (!container || container.dataset.longpressBound) return;
    container.dataset.longpressBound = '1';

    let timer = null;
    container.addEventListener('touchstart', (e) => {
      const card = e.target.closest('.book-card');
      if (!card) return;
      timer = setTimeout(() => {
        const book = window.App && App.findBook(card.dataset.path);
        if (book && window.Library) {
          Library.showContextMenu({ currentTarget: card }, book);
        }
      }, 550);
    }, { passive: true });

    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    container.addEventListener('touchend', cancel, { passive: true });
    container.addEventListener('touchmove', cancel, { passive: true });
    container.addEventListener('touchcancel', cancel, { passive: true });
  }

  // 封面异步准备（12 本 PKZ 封面不需要一次性拆完整本）
  let coverBusy = false;
  async function refreshCovers() {
    if (coverBusy) return;
    if (!window.App || !App.state || !Array.isArray(App.state.books)) return;
    if (!document.getElementById('library-view')?.classList.contains('active')) return;

    const missing = App.state.books.filter(
      (b) => b && b.type === 'manga' && b.coverPath && !b.coverUrl
    );
    if (!missing.length) return;

    coverBusy = true;
    try {
      await window.MobileManga.prepareCovers(missing);
      if (document.getElementById('library-view')?.classList.contains('active')) {
        window.Library.renderBooks();
      }
    } catch (e) { /* ignore */ }
    coverBusy = false;
  }

  // Android 返回键
  function installBackButton() {
    const capApp = window.Capacitor?.Plugins?.App;
    if (!capApp || !capApp.addListener) return;
    capApp.addListener('backButton', () => {
      if (document.body.classList.contains('mobile-drawer-open')) {
        document.body.classList.remove('mobile-drawer-open');
        return;
      }
      const readerOpen =
        document.getElementById('reader-view')?.classList.contains('active') ||
        document.getElementById('txt-view')?.classList.contains('active') ||
        document.getElementById('manga-view')?.classList.contains('active');
      if (readerOpen && window.App) {
        App.goBack();
        return;
      }
      if (capApp.exitApp) capApp.exitApp();
    });
  }

  function boot() {
    installMobileHeader();
    installReaderControls();
    installLongPress();
    installBackButton();
    setTimeout(refreshCovers, 1200);
    setInterval(refreshCovers, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
