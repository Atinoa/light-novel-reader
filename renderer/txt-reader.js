// txt-reader.js
// 独立的 TXT 阅读器。
// 与 EPUB 阅读器（reader.js）在 UI 与渲染逻辑上完全分离：
//   - 使用独立的视图 #txt-view，不触碰 epub.js 的 iframe
//   - 复用同一套阅读设置（App.state.settings）
//   - 进度/书签写入同一 electron-store 结构（bookData，按路径 + type 区分）
//
// 渲染策略：
//   - 分页模式：用隐藏测量 DOM 按真实渲染高度逐段装页，只把当前页插入 DOM
//   - 滚动模式：按章节/子块做窗口化渲染，滚动接近底部再追加下一块，
//     并在块数过多时回收远离视口的旧块（虚拟滚动），避免一次性插入整本 TXT

(function () {
  'use strict';

  const FONT_FAMILIES = {
    system: '"Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif',
    serif: '"宋体", "SimSun", "Songti SC", serif',
    hei: '"黑体", "SimHei", "Microsoft YaHei", "PingFang SC", sans-serif',
    kai: '"楷体", "KaiTi", "STKaiti", "Kaiti SC", serif'
  };

  const ENCODING_LABELS = {
    'utf-8': 'UTF-8',
    'utf-16le': 'UTF-16LE',
    'utf-16be': 'UTF-16BE',
    gbk: 'GBK',
    gb18030: 'GB18030',
    big5: 'Big5'
  };

  // 本次会话内的 TXT 解码缓存，避免重复 IPC 读取
  const txtMemory = new Map();
  const MEMORY_MAX = 3; // 最多缓存 3 本，避免多本大文件占用过多内存
  function cacheSet(key, value) {
    txtMemory.set(key, value);
    while (txtMemory.size > MEMORY_MAX) {
      const oldest = txtMemory.keys().next().value;
      txtMemory.delete(oldest);
    }
  }
  // 滚动模式单块最大字符数：章节过大时拆成子块
  const BLOCK_MAX = 30000;
  // 滚动模式最多保留的块数（窗口化虚拟滚动）
  const MAX_RENDERED_BLOCKS = 20;

  const TxtReader = {
    path: null,
    book: null,
    text: '',
    encoding: '',
    uncertain: false,
    mtime: 0,
    size: 0,
    chapters: [],
    synthetic: false,
    chapterIndex: 0,
    page: 0,
    pages: 1,
    chapterPages: [],       // [{ html, start, end }] 当前章节的精确分页结果
    _pagesChapterIndex: -1,
    _pagesKey: '',
    mode: 'paginated',
    bookmarks: [],
    sidebarPanel: null,
    lastQuery: '',
    highlight: null,       // { start, end } 全文字符偏移
    currentOffset: 0,
    loaded: false,
    allBlocks: [],
    renderedBlocks: [],
    blockIndex: 0,
    _persistTimer: null,
    _scrollTimer: null,
    _reflowTimer: null,
    _resizeTimer: null,
    _searchToken: 0,
    _lastWheel: 0,
    _scrollObserver: null,
    _topSentinel: null,
    _bottomSentinel: null,
    _loadingMore: false,

    // ---------- 初始化：绑定 TXT 视图按钮 ----------
    init() {
      const on = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
      };
      on('txt-btn-back', () => App.goBack());
      on('txt-btn-prev-chapter', () => this.prevChapter());
      on('txt-btn-next-chapter', () => this.nextChapter());
      on('txt-btn-toc', () => this.toggleSidebar('toc'));
      on('txt-btn-bookmarks', () => this.toggleSidebar('bookmarks'));
      on('txt-btn-search', () => this.toggleSidebar('search'));
      on('txt-btn-settings', () => this.toggleSidebar('settings'));
      on('txt-btn-reading-mode', () => this.toggleReadingMode());
      on('txt-btn-add-bookmark', () => this.addBookmark());
      on('txt-btn-do-search', () => this.doSearch());

      const searchInput = document.getElementById('txt-search-input');
      if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.doSearch(); });

      const scroll = document.getElementById('txt-scroll');
      if (scroll) {
        scroll.addEventListener('click', (e) => this.onAreaClick(e));
        scroll.addEventListener('scroll', () => this.onScroll());
        scroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      }

      window.addEventListener('resize', () => {
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => {
          if (this.loaded && this.mode === 'paginated' && document.getElementById('txt-view').classList.contains('active')) {
            this.reflow();
          }
        }, 250);
      });
    },

    // ---------- 打开 ----------
    async open(path, bookEntry) {
      this.reset();
      this.path = path;
      this.book = bookEntry;
      this.showLoading(true);
      this.hideError();
      this.setTitle(bookEntry.title || Library.baseName(path), bookEntry.author || '未知作者');

      try {
        const saved = await this.loadSavedData(path);
        this.bookmarks = (saved && Array.isArray(saved.bookmarks)) ? saved.bookmarks : [];

        const memKey = this.memKey(path);
        let mem = txtMemory.get(memKey);
        if (mem) {
          this.text = mem.text;
          this.encoding = mem.encoding;
          this.mtime = mem.mtime;
          this.size = mem.size;
          this.uncertain = !!mem.uncertain;
        } else {
          // 上次手动选过的编码（存在书的阅读数据里），自动检测不确定时优先沿用
          const savedEnc = (saved && typeof saved.encoding === 'string' &&
            saved.encoding && saved.encoding !== 'auto') ? saved.encoding : null;
          let res = await window.api.readTxt(path);
          // 自动检测结果“不确定”（回退到 GB18030）时，说明这个文件编码有歧义，
          // 用上次手动选择的编码重读，避免每次退出重进都要再手动切一次
          if (res && res.ok && res.uncertain && savedEnc && savedEnc !== res.encoding) {
            const forced = await window.api.readTxtRaw(path, savedEnc);
            if (forced && forced.ok) res = forced;
          }
          if (!res || !res.ok) {
            if (res && res.code === 'EMPTY') {
              this.showLoading(false);
              this.showError('文件为空', false);
            } else {
              this.showLoading(false);
              this.showError((res && res.error) || '读取失败', true);
            }
            return;
          }
          this.text = res.text;
          this.encoding = res.encoding;
          this.mtime = res.mtime;
          this.size = res.size;
          this.uncertain = !!res.uncertain;
          cacheSet(memKey, {
            text: this.text, encoding: this.encoding, mtime: this.mtime, size: this.size, uncertain: this.uncertain
          });
          if (res.large) {
            App.toast(`文件较大（${(res.size / 1024 / 1024).toFixed(1)} MB），首次打开或搜索可能较慢`);
          }
        }

        if (!this.text) {
          this.showLoading(false);
          this.showError('文件为空', false);
          return;
        }

        await this.loadChapters(false);
        this.buildToc();

        const savedOffset = (saved && typeof saved.offset === 'number') ? saved.offset : null;
        this.currentOffset = (savedOffset != null && savedOffset >= 0 && savedOffset < this.text.length)
          ? savedOffset : 0;

        this.loaded = true;
        this.showLoading(false);
        // 立即按当前设置渲染（分页/滚动都由 applySettings 驱动）
        this.applySettings(true);

        if (this.uncertain) App.toast('已按 GB18030 解码，如显示乱码请在设置中切换编码');
        this.renderBookmarks();
      } catch (e) {
        this.showLoading(false);
        this.showError('打开 TXT 失败：' + ((e && e.message) || e), true);
        this.cleanup();
      }
    },

    memKey(path) {
      // 会话内按路径缓存解码结果；同一会话内文件变更的场景较少，重启后由 mtime/size 缓存失效
      return Library.normKey(path);
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

    // ---------- 章节解析 ----------
    async loadChapters(force) {
      this.allBlocks = [];
      this.renderedBlocks = [];
      // 章节变化 / 重新解析后，分页缓存必须失效
      this.chapterPages = [];
      this._pagesChapterIndex = -1;
      this._pagesKey = '';
      if (!force) {
        try {
          const c = await window.api.getTxtCache(this.path);
          if (c && c.ok && c.data &&
              c.data.mtime === this.mtime && c.data.size === this.size &&
              c.data.encoding === this.encoding &&
              Array.isArray(c.data.chapters) && c.data.chapters.length) {
            this.chapters = c.data.chapters;
            this.synthetic = c.data.chapters.every((ch) => ch.synthetic);
            return;
          }
        } catch (e) {}
      }
      const parsed = TxtParser.parse(this.text, { sectionSize: 5000 });
      this.chapters = parsed.chapters;
      this.synthetic = parsed.synthetic;
      // 持久化章节缓存（仅存标题与偏移，体积小）
      try {
        await window.api.setTxtCache(this.path, {
          mtime: this.mtime,
          size: this.size,
          encoding: this.encoding,
          chapters: this.chapters
        });
      } catch (e) {}
    },

    // ---------- 重置 / 清理 ----------
    reset() {
      this.cleanup();
      this.path = null;
      this.book = null;
      this.text = '';
      this.encoding = '';
      this.uncertain = false;
      this.mtime = 0;
      this.size = 0;
      this.chapters = [];
      this.synthetic = false;
      this.chapterIndex = 0;
      this.page = 0;
      this.pages = 1;
      this.chapterPages = [];
      this._pagesChapterIndex = -1;
      this._pagesKey = '';
      this.bookmarks = [];
      this.sidebarPanel = null;
      this.lastQuery = '';
      this.highlight = null;
      this.currentOffset = 0;
      this.loaded = false;
      this.allBlocks = [];
      this.renderedBlocks = [];
      this.blockIndex = 0;
      const ids = ['txt-toc-list', 'txt-bookmark-list', 'txt-search-results'];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
      }
      const content = document.getElementById('txt-content');
      if (content) content.innerHTML = '';
      this.setStatusText('0%', '', '');
      this.closeSidebar();
      this.hideError();
    },

    cleanup() {
      clearTimeout(this._persistTimer);
      clearTimeout(this._scrollTimer);
      clearTimeout(this._reflowTimer);
      this.disconnectScrollObserver();
      const content = document.getElementById('txt-content');
      if (content) content.innerHTML = '';
      this.renderedBlocks = [];
      this.removeMeasure();
    },

    async close() {
      if (this.loaded && this.path) {
        await this.persistBookData();
      }
      this.cleanup();
      this.loaded = false;
    },

    // ---------- UI 辅助 ----------
    setTitle(title, author) {
      const t = document.getElementById('txt-title-text');
      const a = document.getElementById('txt-author-text');
      if (t) t.textContent = title || '—';
      if (a) a.textContent = author || '';
    },
    showLoading(on) {
      const el = document.getElementById('txt-loading');
      if (el) el.classList.toggle('hidden', !on);
    },
    hideError() {
      const el = document.getElementById('txt-error');
      if (!el) return;
      el.classList.add('hidden');
      el.innerHTML = '';
    },
    showError(msg, allowEncoding) {
      const el = document.getElementById('txt-error');
      if (!el) return;
      el.classList.remove('hidden');
      let html =
        '<div class="error-box">' +
          '<div class="error-title">无法打开这本 TXT</div>' +
          `<div class="error-detail">${Library.escapeHtml(msg)}</div>`;
      if (allowEncoding) {
        html +=
          '<div class="txt-encoding-row">' +
            '<label>尝试编码：</label>' +
            '<select id="txt-error-encoding">' +
              ['utf-8', 'gb18030', 'gbk', 'utf-16le', 'utf-16be', 'big5']
                .map((e) => `<option value="${e}">${ENCODING_LABELS[e] || e}</option>`).join('') +
            '</select>' +
            '<button id="txt-error-retry" class="btn btn-small">重新读取</button>' +
          '</div>';
      }
      html += '<button id="txt-error-back" class="btn">返回书库</button></div>';
      el.innerHTML = html;
      const back = document.getElementById('txt-error-back');
      if (back) back.addEventListener('click', () => App.goBack());
      if (allowEncoding) {
        const retry = document.getElementById('txt-error-retry');
        if (retry) retry.addEventListener('click', () => {
          const enc = document.getElementById('txt-error-encoding').value;
          this.reloadWithEncoding(enc);
        });
      }
    },
    setStatusText(percent, chapter, location) {
      const p = document.getElementById('txt-status-percent');
      const c = document.getElementById('txt-status-chapter');
      const l = document.getElementById('txt-status-location');
      if (p) p.textContent = percent;
      if (c) c.textContent = chapter;
      if (l) l.textContent = location;
    },
    encodingLabel() {
      return ENCODING_LABELS[this.encoding] || (this.encoding || '未知');
    },

    // ---------- 设置应用 ----------
    // immediate=true 时立即重排；false 时防抖（用于滑块拖动）
    applySettings(immediate) {
      const s = App.state.settings;
      const scroll = document.getElementById('txt-scroll');
      const content = document.getElementById('txt-content');
      if (!scroll || !content) return;

      const fontPx = 16 * (s.fontSize || 100) / 100;
      content.style.fontSize = fontPx + 'px';
      content.style.lineHeight = String(s.lineHeight || 1.8);
      content.style.padding = (s.pageMargin || 24) + 'px';
      content.style.maxWidth = (s.maxWidth || 840) + 'px';
      content.style.margin = '0 auto';
      content.style.fontFamily = FONT_FAMILIES[s.fontFamily] || FONT_FAMILIES.system;
      content.classList.toggle('indent', s.txtIndent !== false);

      this.mode = s.readingMode === 'scrolled' ? 'scrolled' : 'paginated';
      scroll.classList.toggle('txt-paginated', this.mode === 'paginated');
      scroll.classList.toggle('txt-scrolled', this.mode !== 'paginated');
      if (this.mode === 'paginated') {
        content.style.height = scroll.clientHeight + 'px';
        content.style.overflow = 'hidden';
        this.disconnectScrollObserver();
      } else {
        content.style.height = 'auto';
        content.style.overflow = 'visible';
      }
      this.updateModeUI();

      if (immediate) this.reflow();
      else this.scheduleReflow();
    },

    scheduleReflow() {
      clearTimeout(this._reflowTimer);
      this._reflowTimer = setTimeout(() => this.reflow(), 160);
    },

    // ---------- 分页 / 滚动模式切换 ----------
    toggleReadingMode() {
      this.setReadingMode(this.mode === 'paginated' ? 'scrolled' : 'paginated');
    },

    setReadingMode(mode) {
      const next = mode === 'scrolled' ? 'scrolled' : 'paginated';
      if (!this.loaded) {
        App.state.settings.readingMode = next;
        App.saveSettings();
        this.updateModeUI();
        return;
      }
      if (this.mode === next) { this.updateModeUI(); return; }
      App.state.settings.readingMode = next;
      App.saveSettings();
      // applySettings(true) 会以 currentOffset 为锚点重新定位：
      // 分页→滚动渲染当前块并用滚动位置还原；滚动→分页重新计算页并把偏移映射到所在页。
      this.applySettings(true);
      this.updateModeUI();
      App.toast(next === 'scrolled' ? '已切换为滚动模式' : '已切换为翻页模式');
    },

    updateModeUI() {
      const scrolled = this.mode === 'scrolled';
      const btn = document.getElementById('txt-btn-reading-mode');
      if (btn) {
        btn.textContent = scrolled ? '📜 滚动' : '📖 翻页';
        btn.title = scrolled ? '当前：滚动模式，点击切换为翻页' : '当前：翻页模式，点击切换为滚动';
        btn.classList.toggle('active', scrolled);
      }
      // 滚动模式下禁用工具栏的上一页/下一页箭头；章节仍可通过目录或 Alt+←/→ 跳转
      const prev = document.getElementById('txt-btn-prev-chapter');
      const next = document.getElementById('txt-btn-next-chapter');
      if (prev) {
        prev.disabled = scrolled;
        prev.title = scrolled ? '滚动模式下不可用（使用滚轮 / ↑↓）' : '上一章 (Alt+←)';
      }
      if (next) {
        next.disabled = scrolled;
        next.title = scrolled ? '滚动模式下不可用（使用滚轮 / ↑↓）' : '下一章 (Alt+→)';
      }
      const sel = document.getElementById('t-set-mode');
      if (sel) sel.value = scrolled ? 'scrolled' : 'paginated';
      const scroll = document.getElementById('txt-scroll');
      if (scroll) {
        scroll.classList.toggle('txt-paginated', !scrolled);
        scroll.classList.toggle('txt-scrolled', scrolled);
      }
    },

    reflow() {
      if (!this.loaded || !this.chapters.length) return;
      if (this.mode === 'paginated') {
        const scroll = document.getElementById('txt-scroll');
        const content = document.getElementById('txt-content');
        if (!scroll || !content) return;
        // 每次重排都同步真实容器高度，窗口 resize / 侧栏开关后不会沿用旧高度
        content.style.height = scroll.clientHeight + 'px';
        content.style.overflow = 'hidden';
        this.chapterIndex = TxtParser.findChapterIndex(this.chapters, this.currentOffset);
        this.ensureChapterPages();
        this.page = this.findPageIndex(this.currentOffset);
        this.renderPage();
      } else {
        this.renderScrollFrom(this.currentOffset);
      }
    },

    // 当前章节的精确分页：用隐藏测量 DOM 按真实渲染高度装页
    ensureChapterPages() {
      const ch = this.chapters[this.chapterIndex];
      if (!ch) { this.chapterPages = []; this.pages = 1; return; }
      const key = this.layoutKey();
      if (this._pagesChapterIndex === this.chapterIndex && this._pagesKey === key && this.chapterPages.length) return;

      const scroll = document.getElementById('txt-scroll');
      const content = document.getElementById('txt-content');
      if (scroll && content) {
        content.style.height = scroll.clientHeight + 'px';
        content.style.overflow = 'hidden';
      }

      const measure = this.ensureMeasure();
      const availH = this.getAvailableHeight();
      const blocks = this.buildBlockList(this.text.slice(ch.offset, ch.end), ch.offset);
      const pages = this.packBlocks(blocks, availH, measure);
      if (!pages.length) {
        pages.push({ html: '<div class="txt-line"></div>', start: ch.offset, end: ch.offset });
      }
      this.chapterPages = pages;
      this.pages = pages.length;
      this._pagesChapterIndex = this.chapterIndex;
      this._pagesKey = key;
    },

    // 隐藏测量容器：与 #txt-content 同宽、同 padding、同字体/行高
    ensureMeasure() {
      let el = document.getElementById('txt-measure');
      if (!el) {
        el = document.createElement('div');
        el.id = 'txt-measure';
        el.className = 'txt-content';
        el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(el);
      }
      const content = document.getElementById('txt-content');
      if (!content) return el;
      const cs = getComputedStyle(content);
      const rect = content.getBoundingClientRect();
      el.style.position = 'absolute';
      el.style.left = '-100000px';
      el.style.top = '0';
      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';
      el.style.zIndex = '-1';
      el.style.boxSizing = 'border-box';
      el.style.width = rect.width + 'px';
      el.style.height = 'auto';
      el.style.maxWidth = 'none';
      el.style.margin = '0';
      el.style.padding = cs.padding;
      el.style.fontSize = cs.fontSize;
      el.style.lineHeight = cs.lineHeight;
      el.style.fontFamily = cs.fontFamily;
      el.style.fontWeight = cs.fontWeight;
      el.style.letterSpacing = cs.letterSpacing;
      el.style.whiteSpace = cs.whiteSpace;
      el.style.wordBreak = cs.wordBreak;
      el.style.overflow = 'visible';
      el.classList.toggle('indent', content.classList.contains('indent'));
      return el;
    },

    removeMeasure() {
      const el = document.getElementById('txt-measure');
      if (el) el.remove();
    },

    // 布局缓存键：字体/行距/页边距/最大宽度/字体族/缩进/容器尺寸/高亮
    layoutKey() {
      const s = App.state.settings || {};
      const scroll = document.getElementById('txt-scroll');
      const content = document.getElementById('txt-content');
      const w = content ? Math.round(content.getBoundingClientRect().width) : 0;
      const h = scroll ? scroll.clientHeight : 0;
      const hl = this.highlight ? `${this.highlight.start}-${this.highlight.end}` : '';
      return [s.fontSize, s.lineHeight, s.pageMargin, s.maxWidth, s.fontFamily, s.txtIndent, w, h, hl].join('|');
    },

    getAvailableHeight() {
      const scroll = document.getElementById('txt-scroll');
      const content = document.getElementById('txt-content');
      if (!scroll || !content) return 400;
      const cs = getComputedStyle(content);
      const padT = parseFloat(cs.paddingTop) || 0;
      const padB = parseFloat(cs.paddingBottom) || 0;
      // scroll.clientHeight 已排除横向滚动条；减掉 content 上下 padding 才是正文可用高度
      return Math.max(40, scroll.clientHeight - padT - padB);
    },

    measureHeight(el) {
      const cs = getComputedStyle(el);
      const padT = parseFloat(cs.paddingTop) || 0;
      const padB = parseFloat(cs.paddingBottom) || 0;
      return Math.max(0, el.scrollHeight - padT - padB);
    },

    // 分页用：把章节文本按“空行=段落分隔”组装成段落块
    buildBlockList(slice, baseOffset) {
      return this.buildParagraphList(slice, baseOffset, this.highlight);
    },

    // 以空行为段落分隔，合并段内硬换行；行首空白去除，缩进完全交给 CSS text-indent。
    // 这样每个段落只缩进一次，硬换行不会让每一行都变成“首行”。
    buildParagraphList(slice, baseOffset, hl) {
      const lines = String(slice).split('\n');
      const paragraphs = [];
      let local = 0;
      let current = null;

      const flush = () => {
        if (!current) return;
        let text = current.parts[0].text;
        for (let i = 1; i < current.parts.length; i++) {
          const a = text.slice(-1);
          const b = current.parts[i].text.slice(0, 1);
          // 硬换行合并：英文/数字之间补空格，中文直接相连
          text += (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? ' ' : '') + current.parts[i].text;
        }
        const heading = current.parts.length === 1 && TxtParser.isHeadingLine(current.parts[0].text);
        paragraphs.push({
          text,
          start: current.start,
          end: current.end,
          heading,
          cont: false,
          html: this.paragraphHtml(current.parts, heading, hl)
        });
        current = null;
      };

      for (let raw of lines) {
        raw = raw.replace(/\r$/, '');
        const leading = (raw.match(/^[\s\u3000]*/) || [''])[0].length;
        const text = raw.slice(leading).replace(/\s+$/, '');
        const lineStart = baseOffset + local + leading;
        const lineEnd = baseOffset + local + raw.length;
        local += raw.length + 1;
        if (!text.trim()) { flush(); continue; }
        if (!current) current = { start: lineStart, end: lineEnd, parts: [] };
        current.parts.push({ text, start: lineStart, end: lineEnd });
        current.end = lineEnd;
      }
      flush();
      return paragraphs;
    },

    // 段落 HTML：保留搜索高亮，硬换行英文之间补空格
    paragraphHtml(parts, heading, hl) {
      const esc = Library.escapeHtml;
      let inner = '';
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          const a = parts[i - 1].text.slice(-1);
          const b = parts[i].text.slice(0, 1);
          if (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)) inner += ' ';
        }
        const p = parts[i];
        if (hl && hl.start < p.start + p.text.length && hl.end > p.start) {
          const a = Math.max(0, hl.start - p.start);
          const b = Math.min(p.text.length, hl.end - p.start);
          inner += esc(p.text.slice(0, a)) + '<mark class="txt-mark">' + esc(p.text.slice(a, b)) + '</mark>' + esc(p.text.slice(b));
        } else {
          inner += esc(p.text);
        }
      }
      return `<div class="txt-line${heading ? ' txt-heading' : ''}">${inner}</div>`;
    },

    blockHtml(text, start, heading, cont) {
      const esc = Library.escapeHtml;
      let inner;
      const hl = this.highlight;
      if (hl && hl.start < start + text.length && hl.end > start) {
        const a = Math.max(0, hl.start - start);
        const b = Math.min(text.length, hl.end - start);
        inner = esc(text.slice(0, a)) + '<mark class="txt-mark">' + esc(text.slice(a, b)) + '</mark>' + esc(text.slice(b));
      } else {
        inner = esc(text);
      }
      return `<div class="txt-line${heading ? ' txt-heading' : ''}${cont ? ' txt-cont' : ''}">${inner}</div>`;
    },

    // 把超出一页的段落按真实渲染高度二分切成多段，每段都能完整放入一页
    splitBlock(block, availH) {
      const measure = this.ensureMeasure();
      const limit = Math.max(20, availH - 1);
      const chunks = [];
      let text = block.text;
      let base = block.start;
      let cont = !!block.cont;
      let guard = 0;
      while (text.length && guard++ < 10000) {
        const html = this.blockHtml(text, base, block.heading, cont);
        measure.innerHTML = html;
        if (this.measureHeight(measure) <= limit) {
          chunks.push({ html, start: base, end: base + text.length });
          break;
        }
        // 二分找“最大可放入”的字符前缀
        let lo = 1;
        let hi = text.length - 1;
        let best = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const cut = this.safeCut(text, mid);
          measure.innerHTML = this.blockHtml(text.slice(0, cut), base, block.heading, cont);
          if (this.measureHeight(measure) <= limit) {
            best = cut;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (best <= 0) best = 1;
        const cut = this.safeCut(text, best);
        const chunkText = text.slice(0, cut);
        chunks.push({ html: this.blockHtml(chunkText, base, block.heading, cont), start: base, end: base + chunkText.length });
        text = text.slice(cut);
        base += cut;
        cont = true;
      }
      return chunks;
    },

    // 当前页剩余空间能放多少：head 放进当前页，tail 留到下一页
    splitBlockToFit(block, maxH, measure) {
      const limit = Math.max(10, maxH);
      const cont = !!block.cont;
      const whole = this.blockHtml(block.text, block.start, block.heading, cont);
      measure.innerHTML = whole;
      if (this.measureHeight(measure) <= limit) {
        return { head: { html: whole, start: block.start, end: block.end }, tail: null };
      }
      let lo = 1;
      let hi = block.text.length - 1;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const cut = this.safeCut(block.text, mid);
        measure.innerHTML = this.blockHtml(block.text.slice(0, cut), block.start, block.heading, cont);
        if (this.measureHeight(measure) <= limit) {
          best = cut;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best <= 0) return null;
      const cut = this.safeCut(block.text, best);
      const headText = block.text.slice(0, cut);
      const tailText = block.text.slice(cut);
      const head = {
        html: this.blockHtml(headText, block.start, block.heading, false),
        start: block.start,
        end: block.start + headText.length
      };
      const tailStart = block.start + headText.length;
      const tail = {
        text: tailText,
        start: tailStart,
        end: tailStart + tailText.length,
        heading: block.heading,
        cont: true,
        html: this.blockHtml(tailText, tailStart, block.heading, true)
      };
      return { head, tail };
    },

    // 防止把 emoji 等代理对切成半个字符
    safeCut(text, idx) {
      if (idx <= 0) return 0;
      if (idx >= text.length) return text.length;
      const code = text.charCodeAt(idx);
      if (code >= 0xDC00 && code <= 0xDFFF) return idx - 1;
      return idx;
    },

    // 逐块装页：整段能放就整段放；放不下时用真实高度切出页尾能放下的部分
    packBlocks(blocks, availH, measure) {
      const limit = Math.max(20, availH - 1);
      const pages = [];
      let page = null;

      const startPageWith = (block) => {
        measure.innerHTML = block.html;
        if (this.measureHeight(measure) <= limit) {
          page = { html: block.html, start: block.start, end: block.end, count: 1 };
          return;
        }
        measure.innerHTML = '';
        const chunks = this.splitBlock(block, availH);
        if (!chunks.length) {
          page = { html: block.html, start: block.start, end: block.end, count: 1 };
          return;
        }
        for (let i = 0; i < chunks.length - 1; i++) pages.push(chunks[i]);
        const last = chunks[chunks.length - 1];
        page = { html: last.html, start: last.start, end: last.end, count: 1 };
      };

      const pushPage = () => {
        if (page && page.count > 0) pages.push({ html: page.html, start: page.start, end: page.end });
        page = null;
      };

      for (const b of blocks) {
        if (!page) { startPageWith(b); continue; }

        // 先尝试整段接在当前页后面
        measure.insertAdjacentHTML('beforeend', b.html);
        if (this.measureHeight(measure) <= limit) {
          page.html += b.html;
          page.end = b.end;
          page.count++;
          continue;
        }
        // 整段放不下：移除它，看看当前页还剩多少空间
        const lastEl = measure.lastElementChild;
        if (lastEl) lastEl.remove();
        const used = this.measureHeight(measure);
        const remain = limit - used - 2;
        const lineH = parseFloat(getComputedStyle(measure).lineHeight) || 28;

        // 剩余不足一行：不切，整段移到下一页，避免只有一行的碎页
        if (remain >= lineH * 0.9) {
          const before = page.html;
          const split = this.splitBlockToFit(b, remain, measure);
          if (split && split.head) {
            measure.innerHTML = before + split.head.html;
            if (this.measureHeight(measure) <= limit) {
              page.html = before + split.head.html;
              page.end = split.head.end;
              page.count++;
              pushPage();
              if (split.tail) startPageWith(split.tail);
              continue;
            }
          }
          measure.innerHTML = before;
        }
        pushPage();
        startPageWith(b);
      }
      pushPage();
      return pages;
    },

    findPageIndex(offset) {
      const pages = this.chapterPages;
      if (!pages.length) return 0;
      const pos = Math.max(0, Number(offset) || 0);
      for (let i = 0; i < pages.length; i++) {
        if (pos < pages[i].end) return i;
      }
      return pages.length - 1;
    },

    // ---------- 分页渲染 ----------
    renderPage() {
      if (!this.chapters.length) return;
      this.ensureChapterPages();
      if (this.page >= this.pages) this.page = this.pages - 1;
      if (this.page < 0) this.page = 0;
      const page = this.chapterPages[this.page];
      if (!page) return;
      const content = document.getElementById('txt-content');
      if (content) content.innerHTML = page.html;
      this.currentOffset = page.start;
      this.updateStatus();
      this.schedulePersist();
      if (this.highlight) {
        const mark = content ? content.querySelector('mark.txt-mark') : null;
        if (mark) mark.scrollIntoView({ block: 'center' });
      }
    },

    // ---------- 滚动渲染（窗口化） ----------
    buildBlocks() {
      const blocks = [];
      for (let ci = 0; ci < this.chapters.length; ci++) {
        const ch = this.chapters[ci];
        const len = Math.max(0, ch.end - ch.offset);
        if (len <= BLOCK_MAX) {
          blocks.push({ chapterIndex: ci, start: ch.offset, end: ch.end, isChapterStart: true });
        } else {
          const parts = Math.ceil(len / BLOCK_MAX);
          for (let p = 0; p < parts; p++) {
            const s = ch.offset + p * BLOCK_MAX;
            const e = Math.min(ch.end, s + BLOCK_MAX);
            blocks.push({ chapterIndex: ci, start: s, end: e, isChapterStart: p === 0 });
          }
        }
      }
      return blocks;
    },

    findBlockIndex(offset) {
      const blocks = this.allBlocks;
      if (!blocks.length) return 0;
      let lo = 0;
      let hi = blocks.length - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (blocks[mid].start <= offset) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return ans;
    },

    renderScrollFrom(offset) {
      this.mode = 'scrolled';
      const scroll = document.getElementById('txt-scroll');
      const content = document.getElementById('txt-content');
      if (!scroll || !content) return;
      this.disconnectScrollObserver();
      content.style.height = 'auto';
      content.style.overflow = 'visible';
      if (!this.allBlocks.length) this.allBlocks = this.buildBlocks();
      if (!this.allBlocks.length) return;

      const bi = this.findBlockIndex(offset);
      content.innerHTML = '';
      this.renderedBlocks = [];
      this.blockIndex = bi;
      this.renderBlock(bi);
      if (bi + 1 < this.allBlocks.length) this.renderBlock(bi + 1);
      this.setupScrollObservers();

      const rb = this.renderedBlocks[0];
      if (rb) {
        const block = rb.block;
        const frac = (offset - block.start) / Math.max(1, block.end - block.start);
        scroll.scrollTop = rb.el.offsetTop + Math.max(0, Math.min(1, frac)) * rb.el.offsetHeight;
      }
      this.currentOffset = offset;
      this.chapterIndex = TxtParser.findChapterIndex(this.chapters, offset);
      this.updateStatus();
      this.schedulePersist();

      if (this.highlight) {
        const mark = content.querySelector('mark.txt-mark');
        if (mark) mark.scrollIntoView({ block: 'center' });
      }
    },

    // 用 IntersectionObserver 监听首尾哨兵：接近底部才追加下一块，接近顶部才向前补一块。
    // 超大 TXT 不会一次性渲染全文，DOM 中最多保留约 20 个块。
    setupScrollObservers() {
      this.disconnectScrollObserver();
      const scroll = document.getElementById('txt-scroll');
      const content = document.getElementById('txt-content');
      if (!scroll || !content || typeof IntersectionObserver === 'undefined') return;

      const top = document.createElement('div');
      top.className = 'txt-sentinel';
      top.id = 'txt-sentinel-top';
      const bottom = document.createElement('div');
      bottom.className = 'txt-sentinel';
      bottom.id = 'txt-sentinel-bottom';
      content.insertBefore(top, content.firstChild);
      content.appendChild(bottom);
      this._topSentinel = top;
      this._bottomSentinel = bottom;

      this._scrollObserver = new IntersectionObserver((entries) => {
        if (this.mode !== 'scrolled' || !this.loaded) return;
        for (const ent of entries) {
          if (!ent.isIntersecting) continue;
          if (ent.target === this._bottomSentinel) this.loadMoreScrollBlocks();
          else if (ent.target === this._topSentinel) this.loadPrevScrollBlocks();
        }
      }, { root: scroll, rootMargin: '800px 0px' });
      this._scrollObserver.observe(top);
      this._scrollObserver.observe(bottom);
    },

    disconnectScrollObserver() {
      if (this._scrollObserver) {
        try { this._scrollObserver.disconnect(); } catch (e) {}
        this._scrollObserver = null;
      }
      this._topSentinel = null;
      this._bottomSentinel = null;
    },

    loadMoreScrollBlocks() {
      if (this._loadingMore || this.mode !== 'scrolled') return;
      if (this.blockIndex + 1 >= this.allBlocks.length) return;
      this._loadingMore = true;
      try {
        this.renderBlock(this.blockIndex + 1);
        this.pruneRendered();
        const content = document.getElementById('txt-content');
        if (content && this._bottomSentinel) content.appendChild(this._bottomSentinel);
      } finally {
        setTimeout(() => { this._loadingMore = false; }, 40);
      }
    },

    loadPrevScrollBlocks() {
      if (this._loadingMore || this.mode !== 'scrolled') return;
      this._loadingMore = true;
      try {
        this.prependPreviousBlock();
        const content = document.getElementById('txt-content');
        if (content && this._topSentinel) content.insertBefore(this._topSentinel, content.firstChild);
      } finally {
        setTimeout(() => { this._loadingMore = false; }, 40);
      }
    },

    renderBlock(index) {
      const block = this.allBlocks[index];
      if (!block) return null;
      const content = document.getElementById('txt-content');
      const el = document.createElement('section');
      el.className = 'txt-block';
      el.dataset.block = index;

      const ch = this.chapters[block.chapterIndex];
      let html = '';
      if (ch && ch.synthetic && block.isChapterStart) {
        html += `<div class="txt-chapter-title">${Library.escapeHtml(ch.title)}</div>`;
      }
      html += this.buildLinesHtml(this.text.slice(block.start, block.end), block.start, this.highlight);
      el.innerHTML = html;
      // 保持 bottom sentinel 始终在最后，IntersectionObserver 才能持续触发下一块
      if (this._bottomSentinel && this._bottomSentinel.parentNode === content) {
        content.insertBefore(el, this._bottomSentinel);
      } else {
        content.appendChild(el);
      }
      this.renderedBlocks.push({ el, block });
      this.blockIndex = index;
      return el;
    },

    prependPreviousBlock() {
      if (!this.renderedBlocks.length) return;
      const first = this.renderedBlocks[0];
      const idx = this.allBlocks.indexOf(first.block);
      if (idx <= 0) return;
      const before = this.allBlocks[idx - 1];
      const scroll = document.getElementById('txt-scroll');
      const content = document.getElementById('txt-content');
      const st = scroll.scrollTop;

      const el = document.createElement('section');
      el.className = 'txt-block';
      el.dataset.block = idx - 1;
      const ch = this.chapters[before.chapterIndex];
      let html = '';
      if (ch && ch.synthetic && before.isChapterStart) {
        html += `<div class="txt-chapter-title">${Library.escapeHtml(ch.title)}</div>`;
      }
      html += this.buildLinesHtml(this.text.slice(before.start, before.end), before.start, this.highlight);
      el.innerHTML = html;
      content.insertBefore(el, content.firstChild);
      this.renderedBlocks.unshift({ el, block: before });
      scroll.scrollTop = st + el.offsetHeight;
    },

    pruneRendered() {
      if (this.renderedBlocks.length <= MAX_RENDERED_BLOCKS) return;
      const scroll = document.getElementById('txt-scroll');
      let removed = 0;
      while (this.renderedBlocks.length > MAX_RENDERED_BLOCKS) {
        const rb = this.renderedBlocks[0];
        const bottom = rb.el.offsetTop + rb.el.offsetHeight;
        if (bottom >= scroll.scrollTop - 1200) break;
        removed += rb.el.offsetHeight;
        rb.el.remove();
        this.renderedBlocks.shift();
      }
      if (removed) scroll.scrollTop = Math.max(0, scroll.scrollTop - removed);
    },

    onScroll() {
      if (this.mode !== 'scrolled' || !this.renderedBlocks.length) return;
      clearTimeout(this._scrollTimer);
      this._scrollTimer = setTimeout(() => this.handleScroll(), 120);
    },

    handleScroll() {
      if (!this.renderedBlocks.length) return;
      const scroll = document.getElementById('txt-scroll');
      const st = scroll.scrollTop;

      // 有 IntersectionObserver 时由哨兵负责懒加载；这里只作为不支持 IO 时的回退
      if (!this._scrollObserver) {
        if (st + scroll.clientHeight > scroll.scrollHeight - 900) {
          if (this.blockIndex + 1 < this.allBlocks.length) {
            this.renderBlock(this.blockIndex + 1);
            this.pruneRendered();
          }
        }
        if (st < 500) this.prependPreviousBlock();
      }

      // 计算当前可见位置对应的全文偏移
      let cur = this.renderedBlocks[0];
      for (const rb of this.renderedBlocks) {
        if (rb.el.offsetTop <= st + 2) cur = rb;
        else break;
      }
      const frac = Math.max(0, Math.min(1, (st - cur.el.offsetTop) / Math.max(1, cur.el.offsetHeight)));
      const offset = Math.floor(cur.block.start + frac * (cur.block.end - cur.block.start));
      this.currentOffset = offset;
      const ci = TxtParser.findChapterIndex(this.chapters, offset);
      if (ci !== this.chapterIndex) this.chapterIndex = ci;
      this.updateStatus();
      this.schedulePersist();
    },

    // ---------- 段落渲染（滚动模式） ----------
    // 按空行分段、合并段内硬换行；行首空白由 buildParagraphList 去掉，缩进交给 CSS
    buildLinesHtml(slice, baseOffset, hl) {
      const paragraphs = this.buildParagraphList(slice, baseOffset, hl);
      return paragraphs.map((p) => p.html).join('') || '<div class="txt-line"></div>';
    },

    // ---------- 翻页 / 章节 ----------
    nextPage() {
      if (this.mode !== 'paginated') {
        const scroll = document.getElementById('txt-scroll');
        if (scroll) scroll.scrollBy({ top: Math.floor(scroll.clientHeight * 0.9), behavior: 'smooth' });
        return;
      }
      if (this.page + 1 < this.pages) { this.page++; this.renderPage(); }
      else if (this.chapterIndex + 1 < this.chapters.length) {
        this.chapterIndex++;
        this.page = 0;
        this.renderPage();
      }
    },

    prevPage() {
      if (this.mode !== 'paginated') {
        const scroll = document.getElementById('txt-scroll');
        if (scroll) scroll.scrollBy({ top: -Math.floor(scroll.clientHeight * 0.9), behavior: 'smooth' });
        return;
      }
      if (this.page > 0) { this.page--; this.renderPage(); }
      else if (this.chapterIndex > 0) {
        this.chapterIndex--;
        this.page = 999999; // 由 renderPage 夹取到最后一页
        this.renderPage();
      }
    },

    nextChapter() {
      if (this.chapterIndex + 1 >= this.chapters.length) return;
      this.chapterIndex++;
      this.page = 0;
      if (this.mode === 'paginated') this.renderPage();
      else this.goToOffset(this.chapters[this.chapterIndex].offset);
    },

    prevChapter() {
      if (this.chapterIndex <= 0) return;
      this.chapterIndex--;
      this.page = 0;
      if (this.mode === 'paginated') this.renderPage();
      else this.goToOffset(this.chapters[this.chapterIndex].offset);
    },

    goToOffset(offset, opts) {
      if (!this.chapters.length) return;
      const options = opts || {};
      const pos = Math.max(0, Math.min(Math.max(0, this.text.length - 1), Math.floor(Number(offset) || 0)));
      if (options.highlight !== undefined) this.highlight = options.highlight;
      this.chapterIndex = TxtParser.findChapterIndex(this.chapters, pos);
      this.currentOffset = pos;
      if (this.mode === 'paginated') {
        this.ensureChapterPages();
        this.page = this.findPageIndex(pos);
        this.renderPage();
      } else {
        this.renderScrollFrom(pos);
      }
      this.highlightToc();
    },

    // ---------- 状态 ----------
    updateStatus() {
      const pct = this.text.length ? Math.round((this.currentOffset / this.text.length) * 100) : 0;
      const p = Math.max(0, Math.min(100, pct)) + '%';
      const ch = this.chapters[this.chapterIndex];
      const loc = this.mode === 'paginated'
        ? `第 ${this.page + 1} / ${this.pages} 页 · ${this.encodingLabel()}`
        : `滚动模式 · ${this.encodingLabel()}`;
      this.setStatusText(p, ch ? ch.title : '', loc);
      this.highlightToc();
    },

    // ---------- 目录 ----------
    buildToc() {
      const list = document.getElementById('txt-toc-list');
      if (!list) return;
      if (!this.chapters.length) {
        list.innerHTML = '<div class="panel-empty muted">无法解析章节</div>';
        return;
      }
      list.innerHTML = '';
      if (this.synthetic) {
        const tip = document.createElement('div');
        tip.className = 'panel-empty muted';
        tip.textContent = '未识别到章节标题，已按约 5000 字分节。';
        list.appendChild(tip);
      }
      for (let i = 0; i < this.chapters.length; i++) {
        const ch = this.chapters[i];
        const div = document.createElement('div');
        div.className = 'toc-item';
        div.dataset.index = String(i);
        div.innerHTML = `<span class="toc-label">${Library.escapeHtml(ch.title)}</span>`;
        div.addEventListener('click', () => {
          this.goToOffset(ch.offset);
          this.closeSidebar();
        });
        list.appendChild(div);
      }
      this.highlightToc();
    },

    highlightToc() {
      const items = document.querySelectorAll('#txt-toc-list .toc-item');
      const cur = String(this.chapterIndex);
      items.forEach((el) => {
        const active = el.dataset.index === cur;
        el.classList.toggle('active', active);
        if (active) el.scrollIntoView({ block: 'nearest' });
      });
    },

    // ---------- 书签 ----------
    renderBookmarks() {
      const list = document.getElementById('txt-bookmark-list');
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
            `<div class="bookmark-chapter">${Library.escapeHtml(bm.chapter || '未命名位置')}</div>` +
            `<div class="bookmark-meta muted">进度 ${Math.round(bm.percent || 0)}% · ${bm.time ? new Date(bm.time).toLocaleString('zh-CN') : ''}</div>` +
            (bm.text ? `<div class="bookmark-snippet muted">${Library.escapeHtml(bm.text)}</div>` : '') +
          '</div>' +
          `<button class="btn btn-icon bookmark-del" data-index="${i}" title="删除">✕</button>`;
        div.querySelector('.bookmark-main').addEventListener('click', () => {
          this.goToOffset(bm.offset);
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
      const ch = this.chapters[this.chapterIndex];
      const snippet = this.text.slice(this.currentOffset, this.currentOffset + 80).replace(/\s+/g, ' ').trim();
      this.bookmarks.push({
        offset: this.currentOffset,
        chapter: ch ? ch.title : '',
        chapterIndex: this.chapterIndex,
        percent: this.text.length ? (this.currentOffset / this.text.length) * 100 : 0,
        text: snippet,
        time: Date.now()
      });
      await this.persistBookData();
      this.renderBookmarks();
      App.toast('已添加书签');
    },

    // ---------- 搜索 ----------
    async doSearch() {
      const input = document.getElementById('txt-search-input');
      const q = (input && input.value ? input.value : '').trim();
      if (!q) { App.toast('请输入搜索关键词'); return; }
      this.lastQuery = q;
      const fullEl = document.getElementById('txt-search-full');
      const full = fullEl && fullEl.checked;
      if (full) await this.searchFull(q);
      else this.searchCurrent(q);
    },

    searchCurrent(q) {
      const ch = this.chapters[this.chapterIndex];
      if (!ch) return;
      const hay = this.text.slice(ch.offset, ch.end);
      const results = this.collectMatches(hay, q, ch.offset, ch.title, 200);
      this.renderSearchResults(results, q.length);
      if (!results.length) App.toast('当前章节未找到匹配');
    },

    collectMatches(hay, q, baseOffset, chapterTitle, cap) {
      const results = [];
      const lower = hay.toLowerCase();
      const lq = q.toLowerCase();
      if (!lq) return results;
      let idx = 0;
      while (results.length < cap) {
        const found = lower.indexOf(lq, idx);
        if (found === -1) break;
        results.push({
          offset: baseOffset + found,
          chapterTitle,
          snippet: hay.slice(Math.max(0, found - 30), found + q.length + 40).replace(/\s+/g, ' ').trim()
        });
        idx = found + Math.max(1, lq.length);
      }
      return results;
    },

    async searchFull(q) {
      const token = ++this._searchToken;
      App.toast('正在全文搜索…');
      const results = [];
      const cap = 200;
      try {
        const lower = this.text.toLowerCase();
        const lq = q.toLowerCase();
        let idx = 0;
        let scanned = 0;
        while (results.length < cap) {
          const found = lower.indexOf(lq, idx);
          if (found === -1) break;
          const ci = TxtParser.findChapterIndex(this.chapters, found);
          const ch = this.chapters[ci];
          results.push({
            offset: found,
            chapterTitle: ch ? ch.title : '',
            snippet: this.text.slice(Math.max(0, found - 30), found + q.length + 40).replace(/\s+/g, ' ').trim()
          });
          idx = found + Math.max(1, lq.length);
          scanned++;
          // 每 50 条让出一次事件循环，保证界面可响应（节流）
          if (scanned % 50 === 0) await new Promise((r) => setTimeout(r, 0));
          if (token !== this._searchToken) return; // 已有新的搜索
        }
      } catch (e) {}
      if (token !== this._searchToken) return;
      this.renderSearchResults(results, q.length);
      if (!results.length) App.toast('全文未找到匹配');
    },

    renderSearchResults(results, qLen) {
      const list = document.getElementById('txt-search-results');
      if (!list) return;
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
        div.innerHTML =
          `<div class="search-chapter muted">${Library.escapeHtml(r.chapterTitle || '')}</div>` +
          `<div class="search-snippet">${Library.escapeHtml(r.snippet || '…')}</div>`;
        div.addEventListener('click', () => {
          this.goToOffset(r.offset, { highlight: { start: r.offset, end: r.offset + qLen } });
          this.closeSidebar();
        });
        list.appendChild(div);
      }
      if (results.length >= cap) {
        const more = document.createElement('div');
        more.className = 'panel-empty muted';
        more.textContent = `仅显示前 ${cap} 条结果`;
        list.appendChild(more);
      }
    },

    // ---------- 编码切换 ----------
    async reloadWithEncoding(enc) {
      if (!this.path) { App.goBack(); return; }
      this.showLoading(true);
      this.hideError();
      try {
        const res = await window.api.readTxtRaw(this.path, enc);
        if (!res || !res.ok) {
          this.showLoading(false);
          this.showError((res && res.error) || '读取失败', true);
          return;
        }
        const percent = this.text.length ? this.currentOffset / this.text.length : 0;
        this.text = res.text;
        this.encoding = res.encoding;
        this.uncertain = !!res.uncertain;
        this.mtime = res.mtime;
        this.size = res.size;
        txtMemory.clear();
        await this.loadChapters(true);
        this.buildToc();
        this.loaded = true;
        this.applySettings(true);
        this.goToOffset(Math.floor(percent * this.text.length));
        this.showLoading(false);
        App.toast('已切换编码：' + this.encodingLabel());
      } catch (e) {
        this.showLoading(false);
        this.showError('切换编码失败：' + ((e && e.message) || e), true);
      }
    },

    // ---------- 设置面板 ----------
    buildSettingsForm() {
      const form = document.getElementById('txt-settings-form');
      if (!form) return;
      const s = App.state.settings;
      const themes = [
        { key: 'light', label: '浅色' }, { key: 'dark', label: '深色' },
        { key: 'sepia', label: '护眼米色' }, { key: 'night', label: '夜间' }
      ];
      const fonts = [
        { key: 'system', label: '系统默认' }, { key: 'serif', label: '宋体' },
        { key: 'hei', label: '黑体' }, { key: 'kai', label: '楷体' }
      ];
      const encodings = ['utf-8', 'gb18030', 'gbk', 'utf-16le', 'utf-16be', 'big5'];

      form.innerHTML =
        '<div class="setting-group">' +
          '<div class="setting-label">主题</div>' +
          '<div class="theme-options">' +
            themes.map((t) =>
              `<label class="theme-option ${s.theme === t.key ? 'active' : ''}">` +
                `<input type="radio" name="t-theme" value="${t.key}" ${s.theme === t.key ? 'checked' : ''} />` +
                `<span>${t.label}</span></label>`
            ).join('') +
          '</div>' +
        '</div>' +
        `<div class="setting-group"><div class="setting-label">字体大小 <span class="val" id="t-val-fontsize">${s.fontSize}%</span></div>` +
          `<input type="range" id="t-set-fontsize" min="80" max="200" step="5" value="${s.fontSize}" /></div>` +
        `<div class="setting-group"><div class="setting-label">行距 <span class="val" id="t-val-lineheight">${s.lineHeight}</span></div>` +
          `<input type="range" id="t-set-lineheight" min="1.2" max="2.6" step="0.1" value="${s.lineHeight}" /></div>` +
        `<div class="setting-group"><div class="setting-label">页边距 <span class="val" id="t-val-pagemargin">${s.pageMargin}px</span></div>` +
          `<input type="range" id="t-set-pagemargin" min="8" max="80" step="4" value="${s.pageMargin}" /></div>` +
        `<div class="setting-group"><div class="setting-label">字体</div>` +
          `<select id="t-set-fontfamily">${fonts.map((f) => `<option value="${f.key}" ${s.fontFamily === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}</select></div>` +
        `<div class="setting-group"><div class="setting-label">阅读模式</div>` +
          `<select id="t-set-mode">` +
            `<option value="paginated" ${s.readingMode === 'paginated' ? 'selected' : ''}>分页</option>` +
            `<option value="scrolled" ${s.readingMode === 'scrolled' ? 'selected' : ''}>滚动</option>` +
          `</select></div>` +
        `<div class="setting-group"><div class="setting-label">阅读区最大宽度 <span class="val" id="t-val-maxwidth">${s.maxWidth}px</span></div>` +
          `<input type="range" id="t-set-maxwidth" min="480" max="1600" step="40" value="${s.maxWidth}" /></div>` +
        `<div class="setting-group row"><label class="switch-label">` +
          `<input type="checkbox" id="t-set-indent" ${s.txtIndent !== false ? 'checked' : ''} /> 段首缩进（两个全角空格）</label></div>` +
        `<div class="setting-group"><div class="setting-label">文件编码</div>` +
          `<select id="t-set-encoding">${encodings.map((e) => `<option value="${e}" ${this.encoding === e ? 'selected' : ''}>${ENCODING_LABELS[e] || e}</option>`).join('')}</select>` +
          '<div class="setting-hint muted">乱码时可手动切换编码重新读取</div></div>' +
        '<div class="setting-hint muted">TXT 暂不支持双栏显示（已自动降级为单栏）。</div>' +
        '<div class="setting-actions"><button id="t-btn-reset-book" class="btn btn-danger">重置本书阅读数据</button></div>';

      const bindRange = (id, valId, fmt, apply) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
          const v = parseFloat(el.value);
          const valEl = document.getElementById(valId);
          if (valEl) valEl.textContent = fmt(v);
          apply(v);
        });
        el.addEventListener('change', () => App.saveSettings());
      };

      form.querySelectorAll('input[name="t-theme"]').forEach((inp) => {
        inp.addEventListener('change', () => {
          App.state.settings.theme = inp.value;
          App.applyAppTheme();
          this.applySettings(false);
          App.saveSettings();
          form.querySelectorAll('.theme-option').forEach((o) => o.classList.remove('active'));
          inp.closest('.theme-option').classList.add('active');
        });
      });

      bindRange('t-set-fontsize', 't-val-fontsize', (v) => v + '%', (v) => { App.state.settings.fontSize = v; this.applySettings(false); });
      bindRange('t-set-lineheight', 't-val-lineheight', (v) => v, (v) => { App.state.settings.lineHeight = v; this.applySettings(false); });
      bindRange('t-set-pagemargin', 't-val-pagemargin', (v) => v + 'px', (v) => { App.state.settings.pageMargin = v; this.applySettings(false); });
      bindRange('t-set-maxwidth', 't-val-maxwidth', (v) => v + 'px', (v) => { App.state.settings.maxWidth = v; this.applySettings(false); });

      const fontSel = document.getElementById('t-set-fontfamily');
      if (fontSel) fontSel.addEventListener('change', (e) => {
        App.state.settings.fontFamily = e.target.value;
        this.applySettings(false);
        App.saveSettings();
      });

      const modeSel = document.getElementById('t-set-mode');
      if (modeSel) modeSel.addEventListener('change', (e) => {
        App.state.settings.readingMode = e.target.value;
        this.applySettings(true);
        App.saveSettings();
      });

      const indent = document.getElementById('t-set-indent');
      if (indent) indent.addEventListener('change', (e) => {
        App.state.settings.txtIndent = e.target.checked;
        this.applySettings(false);
        App.saveSettings();
      });

      const encSel = document.getElementById('t-set-encoding');
      if (encSel) encSel.addEventListener('change', (e) => {
        if (e.target.value === this.encoding) return;
        this.reloadWithEncoding(e.target.value);
      });

      const reset = document.getElementById('t-btn-reset-book');
      if (reset) reset.addEventListener('click', () => this.resetBookData());
    },

    async resetBookData() {
      const path = App.state.currentBookPath || this.path;
      if (!path) return;
      this.bookmarks = [];
      this.currentOffset = 0;
      this.chapterIndex = 0;
      this.page = 0;
      await this.persistBookData();
      this.renderBookmarks();
      this.goToOffset(0);
      App.toast('已重置本书阅读数据');
    },

    // ---------- 持久化 ----------
    schedulePersist() {
      clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(() => this.persistBookData(), 900);
    },

    async persistBookData() {
      const path = App.state.currentBookPath || this.path;
      if (!path || !this.loaded) return;
      const book = App.findBook(path);
      const ch = this.chapters[this.chapterIndex];
      const percent = this.text.length ? Math.max(0, Math.min(100, (this.currentOffset / this.text.length) * 100)) : 0;
      const data = {
        type: 'txt',
        offset: this.currentOffset,
        percent,
        chapterIndex: this.chapterIndex,
        chapterTitle: ch ? ch.title : '',
        encoding: this.encoding,
        updatedAt: Date.now(),
        bookmarks: this.bookmarks,
        size: book ? book.size : this.size,
        mtime: book ? book.mtime : this.mtime
      };
      try {
        await window.api.setBookData(path, data);
        App.updateBookData(path, data);
      } catch (e) {}
    },

    // ---------- 侧边栏 ----------
    toggleSidebar(panel) {
      const sidebar = document.getElementById('txt-sidebar');
      if (!sidebar) return;
      if (this.sidebarPanel === panel && !sidebar.classList.contains('hidden')) {
        this.closeSidebar();
        return;
      }
      this.openSidebar(panel);
    },

    openSidebar(panel) {
      const sidebar = document.getElementById('txt-sidebar');
      if (!sidebar) return;
      sidebar.classList.remove('hidden');
      ['toc', 'bookmarks', 'search', 'settings'].forEach((n) => {
        const el = document.getElementById('txt-panel-' + n);
        if (el) el.classList.toggle('hidden', n !== panel);
      });
      this.sidebarPanel = panel;
      if (panel === 'settings') this.buildSettingsForm();
      if (panel === 'toc') this.highlightToc();
      if (panel === 'search') setTimeout(() => {
        const inp = document.getElementById('txt-search-input');
        if (inp) inp.focus();
      }, 50);
      // 侧栏展开会改变阅读区宽度 → 行宽变化，需要重新分页
      if (this.loaded && this.mode === 'paginated') this.scheduleReflow();
    },

    closeSidebar() {
      const sidebar = document.getElementById('txt-sidebar');
      if (sidebar) sidebar.classList.add('hidden');
      this.sidebarPanel = null;
      // 侧栏收起后阅读区变宽，同样重新分页
      if (this.loaded && this.mode === 'paginated') this.scheduleReflow();
    },

    handleEscape() {
      if (this.sidebarPanel) this.closeSidebar();
      else App.goBack();
    },

    // ---------- 阅读区点击左右翻页 ----------
    onAreaClick(e) {
      if (this.mode !== 'paginated') return;
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.toString().trim()) return;
      const scroll = document.getElementById('txt-scroll');
      if (!scroll) return;
      const rect = scroll.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < rect.width * 0.25) this.prevPage();
      else if (x > rect.width * 0.75) this.nextPage();
    },

    // 鼠标滚轮翻页：分页模式向下滚 = 下一页，向上滚 = 上一页；
    // 滚动模式直接放行，交给原生滚动。
    onWheel(e) {
      if (this.mode !== 'paginated') return;
      const dy = e.deltaY || 0;
      const dx = e.deltaX || 0;
      if (Math.abs(dy) <= Math.abs(dx)) return; // 忽略横向滚动
      e.preventDefault();
      if (Math.abs(dy) < 6) return; // 触控板微小滚动忽略
      const now = Date.now();
      if (now - this._lastWheel < 320) return; // 节流
      this._lastWheel = now;
      if (dy > 0) this.nextPage();
      else this.prevPage();
    },

    // ---------- 键盘 ----------
    handleKeydown(e) {
      if (e.key === 'Escape') { this.handleEscape(); return; }
      const tag = ((e.target && e.target.tagName) || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); this.nextChapter(); return; }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); this.prevChapter(); return; }
      if (this.mode === 'paginated') {
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
          e.preventDefault(); this.nextPage();
        } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault(); this.prevPage();
        }
      } else {
        // 滚动模式：显式接管 ↑↓/PageUp/PageDown/空格，保证阅读容器平滑滚动
        const scroll = document.getElementById('txt-scroll');
        if (scroll) {
          if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
            e.preventDefault();
            scroll.scrollBy({ top: Math.floor(scroll.clientHeight * 0.9), behavior: 'smooth' });
          } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
            e.preventDefault();
            scroll.scrollBy({ top: -Math.floor(scroll.clientHeight * 0.9), behavior: 'smooth' });
          }
        }
      }
    }
  };

  window.TxtReader = TxtReader;
  TxtReader.init();
})();
